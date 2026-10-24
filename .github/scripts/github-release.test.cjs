const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { publishRelease } = require('./github-release.cjs');

const digest = data => `sha256:${createHash('sha256').update(data).digest('hex')}`;

function fixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-release-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = 'openswiftui-preview-0.1.2.vsix';
    const data = Buffer.from('packaged extension');
    const sha256 = digest(data).slice(7);
    fs.writeFileSync(path.join(directory, file), data);
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${sha256}  ${file}\n`);
    const config = { repo: 'OpenSwiftUIProject/vscode-openswiftui', tag: '0.1.2', commit: 'a'.repeat(40), directory, file, sha256 };
    const uploadedAsset = name => ({ name, state: 'uploaded', digest: digest(fs.readFileSync(path.join(directory, name))) });
    let release = options.release;
    let tagReads = 0;
    const writes = [];
    function gh(args) {
        if (args[0] === 'api') {
            if (args[1].includes('/git/ref/tags/')) {
                tagReads++;
                if (options.lightweightTag) return JSON.stringify({ object: { type: 'commit', sha: config.commit } });
                return JSON.stringify({ object: { type: 'tag', sha: 'b'.repeat(40) } });
            }
            if (args[1].includes('/git/tags/')) {
                return JSON.stringify({ object: { type: 'commit', sha: options.movedTag && tagReads > 1 ? 'c'.repeat(40) : config.commit } });
            }
            if (args[1].includes('/releases/tags/')) {
                if (release && !release.draft) return JSON.stringify(release);
                throw Object.assign(new Error('Request failed'), { stderr: Buffer.from(`gh: Not Found (HTTP ${options.status || 404})`) });
            }
            if (args[1].endsWith('/releases?per_page=100')) {
                if (options.listStatus) {
                    throw Object.assign(new Error('Release listing failed'), { stderr: Buffer.from(`gh: Forbidden (HTTP ${options.listStatus})`) });
                }
                const pages = [...(options.releasePages || []), release ? [release] : []];
                if (!args.includes('--paginate')) return JSON.stringify(pages[0]);
                return args.includes('--slurp') ? JSON.stringify(pages) : pages.map(page => JSON.stringify(page)).join('\n');
            }
        }
        writes.push(args);
        if (args[0] === 'release' && args[1] === 'create') {
            release = { tag_name: config.tag, draft: true, prerelease: false, assets: [], html_url: 'https://github.com/example/release' };
        } else if (args[0] === 'release' && args[1] === 'upload') {
            for (const filePath of args.slice(3, args.indexOf('--repo'))) {
                const asset = uploadedAsset(path.basename(filePath));
                if (options.alteredUpload) asset.digest = `sha256:${'0'.repeat(64)}`;
                release.assets.push(asset);
            }
        } else if (args[0] === 'release' && args[1] === 'edit') {
            release.draft = false;
        } else {
            throw new Error(`Unexpected command: ${args.join(' ')}`);
        }
        return '';
    }
    return { config, gh, writes, uploadedAsset, release: () => release };
}

test('creates a draft, uploads both assets, and publishes only after verification', t => {
    const f = fixture(t);
    publishRelease(f.config, f.gh);
    assert.deepEqual(f.writes.map(args => args[1]), ['create', 'upload', 'edit']);
    assert.ok(f.writes[0].includes('--verify-tag'));
    assert.ok(f.writes[0].includes('--draft'));
    assert.equal(f.release().draft, false);
    assert.deepEqual(f.release().assets.map(asset => asset.name), [f.config.file, 'SHA256SUMS']);
});

test('a matching published release is a read-only success', t => {
    const release = { tag_name: '0.1.2', draft: false, prerelease: false, assets: [], html_url: 'https://github.com/example/release' };
    const f = fixture(t, { release });
    release.assets = [f.uploadedAsset(f.config.file), f.uploadedAsset('SHA256SUMS')];
    publishRelease(f.config, f.gh);
    assert.deepEqual(f.writes, []);
});

test('supports lightweight version tags', t => {
    const f = fixture(t, { lightweightTag: true });
    publishRelease(f.config, f.gh);
    assert.equal(f.release().draft, false);
});

test('resumes a partial draft without replacing an existing asset', t => {
    const release = { tag_name: '0.1.2', draft: true, prerelease: false, assets: [] };
    const f = fixture(t, { release });
    release.assets = [f.uploadedAsset(f.config.file)];
    publishRelease(f.config, f.gh);
    assert.deepEqual(f.writes.map(args => args[1]), ['upload', 'edit']);
    assert.equal(f.writes[0][3], path.join(f.config.directory, 'SHA256SUMS'));
    assert.ok(!f.writes[0].includes('--clobber'));
});

test('finds an existing draft after the first release page', t => {
    const release = { tag_name: '0.1.2', draft: true, prerelease: false, assets: [] };
    const f = fixture(t, { release, releasePages: [
        [{ tag_name: '0.1.1', draft: false, prerelease: false, assets: [] }],
        [{ tag_name: '0.2.0', draft: true, prerelease: false, assets: [] }],
    ] });
    publishRelease(f.config, f.gh);
    assert.deepEqual(f.writes.map(args => args[1]), ['upload', 'edit']);
    assert.equal(f.release().draft, false);
});

test('does not create a release when draft listing fails', t => {
    const f = fixture(t, { listStatus: 403 });
    assert.throws(() => publishRelease(f.config, f.gh), /Release listing failed/);
    assert.deepEqual(f.writes, []);
});

test('rejects a conflicting asset without changing the release', t => {
    const f = fixture(t, { release: { tag_name: '0.1.2', draft: true, prerelease: false, assets: [
        { name: 'openswiftui-preview-0.1.2.vsix', state: 'uploaded', digest: `sha256:${'0'.repeat(64)}` },
    ] } });
    assert.throws(() => publishRelease(f.config, f.gh), /does not match/);
    assert.deepEqual(f.writes, []);
});

test('does not modify an incomplete published release', t => {
    const f = fixture(t, { release: { tag_name: '0.1.2', draft: false, prerelease: false, assets: [] } });
    assert.throws(() => publishRelease(f.config, f.gh), /Published release is missing/);
    assert.deepEqual(f.writes, []);
});

test('does not convert a prerelease into a stable release', t => {
    const f = fixture(t, { release: { tag_name: '0.1.2', draft: false, prerelease: true, assets: [] } });
    assert.throws(() => publishRelease(f.config, f.gh), /stable release request/);
    assert.deepEqual(f.writes, []);
});

test('does not publish when the uploaded assets fail verification', t => {
    const f = fixture(t, { alteredUpload: true });
    assert.throws(() => publishRelease(f.config, f.gh), /does not match/);
    assert.equal(f.release().draft, true);
    assert.ok(!f.writes.some(args => args[1] === 'edit'));
});

test('does not treat authentication failures as a missing release', t => {
    const f = fixture(t, { status: 401 });
    assert.throws(() => publishRelease(f.config, f.gh), /Request failed/);
    assert.deepEqual(f.writes, []);
});

test('rejects a changed tag before publishing the draft', t => {
    const f = fixture(t, { movedTag: true });
    assert.throws(() => publishRelease(f.config, f.gh), /tag no longer matches/);
    assert.equal(f.release().draft, true);
    assert.ok(!f.writes.some(args => args[1] === 'edit'));
});

test('rejects an altered VSIX before any API request', t => {
    const f = fixture(t);
    fs.appendFileSync(path.join(f.config.directory, f.config.file), 'changed');
    assert.throws(() => publishRelease(f.config, () => assert.fail('Unexpected API request')), /checksum/);
});

test('rejects an invalid tag or asset path before any API request', t => {
    const f = fixture(t);
    const gh = () => assert.fail('Unexpected API request');
    assert.throws(() => publishRelease({ ...f.config, tag: 'v0.1.2' }, gh), /stable version/);
    assert.throws(() => publishRelease({ ...f.config, file: '../package.vsix' }, gh), /VSIX file/);
});
