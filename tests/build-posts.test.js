const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('新同步的 Anolis OS 笔记生成后位于首页第一篇', () => {
  execFileSync(process.execPath, ['scripts/build-posts.js'], {
    cwd: root,
    stdio: 'pipe'
  });

  const posts = JSON.parse(fs.readFileSync(path.join(root, 'posts.json'), 'utf8'));

  assert.equal(posts.length, 33);
  assert.equal(posts[0].slug, 'anolisos-8-10-ext4-boot-recovery');
  assert.equal(posts[0].category, 'Linux');
  assert.ok(fs.existsSync(path.join(root, 'content/anolisos-8-10-ext4-boot-recovery.md')));
  assert.ok(fs.existsSync(path.join(root, 'posts/anolisos-8-10-ext4-boot-recovery.html')));
});

test('Anolis OS 笔记的 Bash 示例不包含会被解释为重定向的尖括号占位符', () => {
  const markdown = fs.readFileSync(
    path.join(root, 'content/anolisos-8-10-ext4-boot-recovery.md'),
    'utf8'
  );
  const bashBlocks = [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);

  assert.ok(bashBlocks.length > 0);
  for (const block of bashBlocks) {
    assert.doesNotMatch(block, /<[A-Z][A-Z_]*>/);
  }
});
