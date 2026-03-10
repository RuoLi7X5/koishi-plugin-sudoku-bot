// 验证插件导出
const plugin = require('./lib/index.js');

console.log('=== 插件验证 ===');
console.log('插件名称:', plugin.name);
console.log('Config 类型:', typeof plugin.Config);
console.log('apply 类型:', typeof plugin.apply);
console.log('Config 是否为 Schema:', plugin.Config?.type === 'intersect' || plugin.Config?.type === 'object');

if (plugin.name && plugin.Config && plugin.apply) {
  console.log('\n✅ 插件导出正确！');
} else {
  console.log('\n❌ 插件导出有问题');
  if (!plugin.name) console.log('  - 缺少 name');
  if (!plugin.Config) console.log('  - 缺少 Config');
  if (!plugin.apply) console.log('  - 缺少 apply');
}
