const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('生成器输出与内容目录保持完整且无重复', () => {
  execFileSync(process.execPath, ['scripts/build-posts.js'], {
    cwd: root,
    stdio: 'pipe'
  });

  const posts = JSON.parse(fs.readFileSync(path.join(root, 'posts.json'), 'utf8'));
  const postSlugs = posts.map((post) => post.slug).sort();
  const contentSlugs = fs.readdirSync(path.join(root, 'content'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => file.slice(0, -3))
    .sort();
  const generatedSlugs = fs.readdirSync(path.join(root, 'posts'))
    .filter((file) => file.endsWith('.html'))
    .map((file) => file.slice(0, -5))
    .sort();

  assert.equal(new Set(postSlugs).size, postSlugs.length);
  assert.deepEqual(postSlugs, contentSlugs);
  assert.deepEqual(postSlugs, generatedSlugs);
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
