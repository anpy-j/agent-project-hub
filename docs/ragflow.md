# 本机 RAGFlow 连接

打开「全局设置 → 知识库」。默认服务地址为 `http://127.0.0.1:14310`，默认知识库 ID 为 `fec3d0e093d34a0c91a5fe1b65841f0e`。

1. 填写 RAGFlow API Key。
2. 点击「测试连接 / 获取知识库」，验证认证及目标知识库访问权限。若 ID 不匹配，可清空 ID 后测试，再选择可访问的知识库。
3. 点击「验证并保存」，成功后加载最多 20 条文档及解析状态。
4. 点击「打开已保存的知识库」在浏览器查看 RAGFlow。

API Key 使用 Electron safeStorage 加密，存储在应用 userData 下的 ragflow-v1.json；不会回传已保存的密钥。更换地址需重新输入 Key。请求在主进程执行，15 秒超时，不跟随重定向。测试未保存的表单不会修改当前配置。

本次实现连接、认证、知识库选择、保存和文档预览；文章抓取、总结、上传和自动解析尚未接入。

验证：`node --import tsx --test tests/ragflow-client.test.ts`、`npm run typecheck`、`npm run build`、`node tests/run-electron-ragflow-smoke.cjs`。
