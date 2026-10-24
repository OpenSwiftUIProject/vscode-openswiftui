const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function runGitHub(args) {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function publishRelease({ repo, tag, commit, directory, file, sha256 }, gh = runGitHub) {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
        throw new Error('Use a stable version without a v prefix.');
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[a-f0-9]{40}$/.test(commit)) {
        throw new Error('Invalid repository or commit.');
    }
    if (file !== `openswiftui-preview-${tag}.vsix`) throw new Error('Unexpected VSIX file name.');
    const digest = data => `sha256:${createHash('sha256').update(data).digest('hex')}`;
    const packageData = fs.readFileSync(path.join(directory, file));
    const sums = fs.readFileSync(path.join(directory, 'SHA256SUMS'));
    if (!/^[a-f0-9]{64}$/.test(sha256) || digest(packageData) !== `sha256:${sha256}` ||
        sums.toString() !== `${sha256}  ${file}\n`) {
        throw new Error('Release artifact checksum does not match the package job.');
    }
    const assets = new Map([[file, digest(packageData)], ['SHA256SUMS', digest(sums)]]);
    const api = endpoint => JSON.parse(gh(['api', `repos/${repo}/${endpoint}`]));

    function verifyTag() {
        let object = api(`git/ref/tags/${tag}`).object;
        for (let depth = 0; object.type === 'tag' && depth < 10; depth++) {
            object = api(`git/tags/${object.sha}`).object;
        }
        if (object.type !== 'commit' || object.sha !== commit) {
            throw new Error('The release tag no longer matches the tested commit.');
        }
    }

    function readRelease() {
        try {
            return api(`releases/tags/${tag}`);
        } catch (error) {
            if (!/\(HTTP 404\)/.test(String(error.stderr))) throw error;
        }
        // The tag endpoint excludes drafts. List releases before creating another.
        const pages = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp']));
        const matches = pages.flat().filter(release => release.tag_name === tag);
        if (matches.length > 1) throw new Error('Multiple releases use the requested tag.');
        return matches[0];
    }

    function missingAssets(release) {
        if (!release || release.tag_name !== tag || release.prerelease || !Array.isArray(release.assets)) {
            throw new Error('The GitHub release does not match the stable release request.');
        }
        return [...assets].flatMap(([name, expectedDigest]) => {
            const asset = release.assets.find(candidate => candidate.name === name);
            if (!asset) return [name];
            if (asset.state !== 'uploaded' || asset.digest !== expectedDigest) {
                throw new Error(`Existing release asset ${name} does not match. Do not overwrite it.`);
            }
            return [];
        });
    }

    verifyTag();
    let release = readRelease();
    if (!release) {
        gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--target', commit,
            '--draft', '--title', tag, '--generate-notes', '--notes',
            'Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=OpenSwiftUIProject.openswiftui-preview) or use the universal VSIX below.']);
        release = readRelease();
    }
    const missing = missingAssets(release);
    if (!release.draft) {
        if (missing.length) throw new Error(`Published release is missing assets: ${missing.join(', ')}. Repair it manually.`);
        return release.html_url;
    }
    if (missing.length) {
        gh(['release', 'upload', tag, ...missing.map(name => path.join(directory, name)), '--repo', repo]);
    }
    if (missingAssets(readRelease()).length) throw new Error('Release asset upload is incomplete.');
    verifyTag();
    gh(['release', 'edit', tag, '--repo', repo, '--draft=false']);
    release = readRelease();
    if (missingAssets(release).length || release.draft) throw new Error('Release publication is incomplete.');
    return release.html_url;
}

module.exports = { publishRelease };

if (require.main === module) {
    const url = publishRelease({
        repo: process.env.GITHUB_REPOSITORY,
        tag: process.env.RELEASE_TAG,
        commit: process.env.RELEASE_COMMIT,
        directory: process.env.RELEASE_DIRECTORY,
        file: process.env.VSIX_FILE,
        sha256: process.env.VSIX_SHA256,
    });
    console.log(url);
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `GitHub Release: ${url}\n`);
    }
}
