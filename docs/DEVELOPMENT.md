# 开发与发布流程

## 环境要求

- Node.js >=20 <25
- npm 10 或兼容版本
- Docker Desktop（本地构建容器时需要）

检查版本：

~~~bash
node --version
npm --version
~~~

## 本地开发

~~~bash
git clone git@github.com:ZZJ1977/groupproof.git
cd groupproof
npm ci
cp .env.example .env.local
npm run dev
~~~

打开 http://localhost:3000。当前前端默认使用 Mock 数据，不需要启动后端、数据库或 Redis。

## 环境变量

模板文件为 .env.example：

~~~env
NEXT_PUBLIC_APP_ENV=development
NEXT_PUBLIC_ENABLE_MOCKS=true
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
API_INTERNAL_URL=http://localhost:8000
NEXT_PUBLIC_ADMIN_URL=http://localhost:3002
~~~

NEXT_PUBLIC_ 变量会进入浏览器包，只能放公开地址和功能开关。数据库连接串、JWT 密钥、OAuth secret、对象存储密钥、AI 密钥和 Railway token 只能放在 .env.local、Railway Variables 或 GitHub Secrets。

接入真实 API 后，将 NEXT_PUBLIC_ENABLE_MOCKS 改为 false，并设置 API 地址。

## 本地检查

提交到测试环境前执行：

~~~bash
npm run lint
npm run typecheck
npm run check:routes
npm run build
~~~

启动开发服务器后，检查 56 个页面的 HTTP 状态：

~~~bash
CHECK_HTTP=1 npm run check:routes
~~~

## 本地生产启动

普通 Next.js 生产服务器：

~~~bash
npm run build
npm run start
~~~

Railway 使用的 standalone 服务器：

~~~bash
npm run build
HOSTNAME=0.0.0.0 PORT=3000 npm run start:standalone
~~~

健康检查地址为 http://localhost:3000/healthz。

## Docker

构建并运行生产镜像：

~~~bash
docker build -t groupproof-web:local .
docker run --rm --name groupproof-web \
  --env-file .env.local \
  -p 3000:3000 \
  groupproof-web:local
~~~

如果没有 .env.local，先执行 cp .env.example .env.local。容器启动后检查：

~~~bash
curl --fail http://localhost:3000/healthz
curl --fail http://localhost:3000/
~~~

## 组员协作

仓库为私有仓库。负责人在 GitHub 的 Settings → Collaborators → Add people 中邀请成员，普通开发成员使用 Write 权限。

每个成员从 develop 创建自己的功能分支：

~~~bash
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c feat/task-evidence
~~~

本地检查通过后提交功能分支，并将它合入 develop：

~~~bash
git add .
git commit -m "feat: add task evidence workflow"
git switch develop
git pull --ff-only origin develop
git merge --no-ff feat/task-evidence -m "merge: task evidence workflow"
git push origin develop
~~~

不要提交 .env.local、数据库密码、OAuth secret、AI key 或 Railway token。

## 测试到生产

发布链路固定为：

~~~text
功能分支本地测试
  ↓
推送 develop
  ↓
GitHub Actions 质量检查和 Docker 检查
  ↓
Railway Staging 自动部署
  ↓
测试环境验收
  ↓
develop 同步到 main
  ↓
GitHub Actions 质量检查和 Docker 检查
  ↓
Railway Production 自动部署
~~~

测试环境通过后，由负责人同步到 main：

~~~bash
git switch main
git pull --ff-only origin main
git merge --ff-only origin/develop
git push origin main
~~~

测试环境：

https://groupproof-staging-production.up.railway.app

生产环境：

https://groupproof-production-production.up.railway.app

## CI/CD

工作流文件为 .github/workflows/ci-cd.yml，在 develop 和 main 推送时执行：

1. 安装锁定依赖。
2. 执行 lint、TypeScript 和路由检查。
3. 构建并启动 standalone 服务。
4. 检查首页、健康检查和全部 56 个页面。
5. 构建 Docker 镜像并检查容器。
6. 按配置选择 Railway 部署。

当前 Railway GitHub 集成负责自动部署，GitHub Actions 负责质量门禁。不要同时启用 Railway 自动部署和 Actions deploy job，避免一次推送产生重复部署。

