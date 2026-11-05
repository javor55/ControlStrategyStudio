import { describe, expect, it } from 'vitest';
import { demoProjectFiles } from '@csd/core';
import { ProjectRepo, VcsError } from '../src';

const FIC = 'strategies/ACME/Brno/WaterTreatment/U100/FIC101.yaml';
const me = { name: 'Process Engineering', email: 'pe@example.com' };

describe('ProjectRepo', () => {
  it('commits, logs and reads files back', async () => {
    const repo = await ProjectRepo.open();
    const files = demoProjectFiles();
    expect(await repo.changes(files)).toHaveLength(Object.keys(files).length);
    const c1 = await repo.commit(files, 'Initial design', me);
    expect(await repo.changes(files)).toEqual([]);
    await expect(repo.commit(files, 'again', me)).rejects.toBeInstanceOf(VcsError);

    const edited = { ...files, [FIC]: (files[FIC] as string).replace('GAIN: 0.8', 'GAIN: 0.9'), 'assets/logo.png': new Uint8Array([137, 80, 78, 71]) };
    delete (edited as Record<string, unknown>)['README.md'];
    const ch = await repo.changes(edited);
    expect(ch).toHaveLength(3);
    expect(ch).toEqual(
      expect.arrayContaining([
        { path: 'README.md', kind: 'deleted' },
        { path: 'assets/logo.png', kind: 'added' },
        { path: FIC, kind: 'modified' },
      ]),
    );
    const c2 = await repo.commit(edited, 'Retune FIC101\n\nGain from loop test', me);
    const log = await repo.log();
    expect(log.map((c) => c.summary)).toEqual(['Retune FIC101', 'Initial design']);
    expect(log[0]).toMatchObject({ oid: c2, parents: [c1], message: 'Retune FIC101\n\nGain from loop test', author: { name: me.name } });
    expect((await repo.filesAt(c1))[FIC]).toContain('GAIN: 0.8');
    expect((await repo.filesAt())['assets/logo.png']).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(await repo.changesBetween(c1, c2)).toHaveLength(3);
  });

  it('resolves tags with names that look like commit ids', async () => {
    const repo = await ProjectRepo.open();
    const files = demoProjectFiles();
    const c1 = await repo.commit(files, 'Rev A', me);
    await repo.tag('2025');
    await repo.tag('cafe');
    expect(await repo.resolve('2025')).toBe(c1);
    expect(await repo.resolve('cafe')).toBe(c1);
    expect(await repo.resolve(c1.slice(0, 7))).toBe(c1);
  });

  it('tags revisions and survives a round trip through stored .git files', async () => {
    const repo = await ProjectRepo.open();
    const files = demoProjectFiles();
    const c1 = await repo.commit(files, 'Rev A', me);
    await repo.tag('rev-A', { message: 'Issued for review' });
    await expect(repo.tag('rev-A')).rejects.toThrow(/exists/);
    await expect(repo.tag('bad name')).rejects.toThrow(/valid/);
    const again = await ProjectRepo.open(repo.gitFiles());
    expect(await again.tags()).toEqual([{ name: 'rev-A', oid: c1, message: 'Issued for review' }]);
    expect((await again.log())[0].tags).toEqual(['rev-A']);
    expect(await again.resolve('rev-A')).toBe(c1);
    expect(await again.changes(files)).toEqual([]);
  });

  it('creates and switches branches', async () => {
    const repo = await ProjectRepo.open();
    const files = demoProjectFiles();
    await expect(repo.createBranch('variant')).rejects.toThrow(/first commit/);
    await repo.commit(files, 'base', me);
    await repo.createBranch('variant-ratio');
    const onBranch = await repo.switchBranch('variant-ratio');
    expect(await repo.currentBranch()).toBe('variant-ratio');
    await repo.commit({ ...onBranch, [FIC]: (onBranch[FIC] as string) + '# variant\n' }, 'Try ratio control', me);
    const main = await repo.switchBranch('main');
    expect(main[FIC]).not.toContain('# variant');
    expect((await repo.fileAt('variant-ratio', FIC)) as string).toContain('# variant');
    expect((await repo.branches()).map((b) => `${b.name}${b.current ? '*' : ''}`)).toEqual(['main*', 'variant-ratio']);
    await expect(repo.deleteBranch('main')).rejects.toThrow(/Switch/);
    await repo.deleteBranch('variant-ratio');
    expect((await repo.branches()).map((b) => b.name)).toEqual(['main']);
  });

  it('exports .git with an index for ordinary git', async () => {
    const repo = await ProjectRepo.open();
    const files = demoProjectFiles();
    await repo.commit(files, 'base', me);
    const out = await repo.exportForZip(files);
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['.git/HEAD', '.git/index']));
    expect(new TextDecoder().decode(out['.git/HEAD'])).toBe('ref: refs/heads/main\n');
  });
});
