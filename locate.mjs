import fs from 'fs';
const cl = JSON.parse(fs.readFileSync('D:/obsidian/vaults/学术笔记/已解析著作/Controversy Over the Existence of the World/merged_content_list.json', 'utf8'));
const keys = [
  'four different pairs of opposite existential moments',
  'every purely intentional entity is heteronomous',
  'merely contingently struck by the intention',
  'originality of an entity necessarily implies its autonomy',
  'if an entity is simultaneously existentially autonomous, original, selfsufficient and independent',
  'Absolute supratemporal being',
  'Supratemporal',
  'Temporally determined (real?) being',
  'Purely intentional being',
  'four different modes of being and four domains of being',
  'simulated',
  'aging',
  'activeness of [an entity]',
  'presupposes its autonomy',
  'the realm of the heteronomous'
];
const found = {};
function walk(items) {
  for (const it of items) {
    const t = (it.text || '').replace(/\s+/g, ' ');
    for (const k of keys) {
      if (!found[k] && t.includes(k)) found[k] = it.page_idx;
    }
    if (it.children) walk(it.children);
  }
}
walk(cl);
for (const k of keys) console.log(found[k] !== undefined ? `PDF p${found[k]}: ${k}` : `NOT FOUND: ${k}`);
