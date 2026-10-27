'use strict';
// 请求级“当前用户”上下文：用 AsyncLocalStorage 承载，使 resolveWithin 在不必改造
// 40+ 个文件操作调用点的情况下，也能把 __home__ 根解析到“当前请求者本人”的目录。
// 会话中间件在放行每个 /api 请求时会 userCtx.run(req.user, () => next()) 写入。
const { AsyncLocalStorage } = require('async_hooks');
module.exports = new AsyncLocalStorage();
