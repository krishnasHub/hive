# @hive/plugin-sdk

Type definitions for Hive plugins. See [docs/PLUGINS.md](../../docs/PLUGINS.md) for the guide.

```js
/** @type {import('@hive/plugin-sdk').HivePlugin} */
module.exports = {
  activate(ctx) {
    ctx.channel.register({ send: async (msg) => ({ threadRef: '...' }) })
  }
}
```
