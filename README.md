# 养蚕专家

儿童向养蚕问答网站，支持：

- 通俗回答 + 资料链接 + 小测验
- 积分成长（8 个阶段）
- 语音输入 / 语音播报
- 后端调用大模型（默认 `DeepSeek-V3.2`）

---

## 本地运行

### 1) 准备知识库（可选，但推荐）

把 PDF 放到项目根目录 `data/` 后执行：

```bash
python -m pip install -r tools/requirements.txt
python tools/ingest_pdfs.py
```

生成：`server/knowledge/index.json`

### 2) 启动后端

```bash
cd server
node server.js
```

### 3) 打开前端

直接打开 `index.html` 即可。

---

## 快速公网部署（方案 A）

目标：前端上 **Vercel**，后端上 **Render**，所有人都能访问。

### A-1. 部署后端到 Render

1. 把项目推到 GitHub。
2. 在 Render 新建 `Web Service`，选择此仓库。
3. Render 会自动识别根目录下的 `render.yaml`（已提供）。
4. 在 Render 补充环境变量（至少）：
   - `OPENAI_API_KEY` = 你的真实 key
   - 可选：`OPENAI_MODEL`、`OPENAI_BASE_URL`
5. 部署完成后拿到后端地址，例如：
   - `https://silkworm-expert-api.onrender.com`

### A-2. 部署前端到 Vercel

1. 在 Vercel 导入同一个仓库（静态站点）。
2. 部署完成后，会得到前端地址。
3. 打开项目里的 `index.html`，把这行改成你的 Render 地址：

```html
<meta name="silkworm-api-base" content="https://silkworm-expert-api.onrender.com" />
```

4. 提交后，Vercel 会自动重新部署。

### A-3. 验证

- 打开前端页面提问，能返回回答与“直接资料”
- 访问后端健康检查：
  - `https://你的-render域名/api/health`

---

## 说明

- 当前 `server` 是零依赖 `node:http` 实现，`npm start` 即可运行。
- 如果模型偶尔不给链接，后端会自动补“公众号优先”的兜底资料，避免空白。
- 公众号链接可能出现“环境异常/去验证”，属于微信侧策略，页面会显示提示。
