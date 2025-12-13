# Dokploy 手动升级完整指南

## 📋 目录

1. [正常升级流程](#正常升级流程)
2. [升级到指定版本](#升级到指定版本)
3. [故障排查与修复](#故障排查与修复)
4. [回滚方案](#回滚方案)
5. [常见问题](#常见问题)

---

## 🚀 正常升级流程

### 方法 1: 使用 Docker 命令（推荐）

#### 升级到最新版本（latest）

```bash
# 1. 拉取最新镜像
docker pull a3180623/dokploy-i18n:latest

# 2. 更新服务
docker service update --force --image a3180623/dokploy-i18n:latest dokploy

# 3. 等待服务启动（通常需要 30-60 秒）
sleep 30

# 4. 检查服务状态
docker service ps dokploy

# 5. 查看日志确认启动成功
docker service logs dokploy --tail 50

# 6. 验证访问
curl http://localhost:3000/api/health
```

#### 升级到指定版本

```bash
# 1. 拉取指定版本镜像
docker pull a3180623/dokploy-i18n:v0.25.15

# 2. 更新服务
docker service update --force --image a3180623/dokploy-i18n:v0.25.15 dokploy

# 3. （可选）如果要固定使用这个版本，设置环境变量
docker service update --env-add RELEASE_TAG=v0.25.15 dokploy

# 4. 等待并验证
sleep 30
docker service ps dokploy
docker service logs dokploy --tail 30
```

### 方法 2: 使用安装脚本

```bash
# 升级到 latest
bash install.sh update

# 升级到指定版本
DOKPLOY_VERSION=v0.25.15 bash install.sh update
```

### 方法 3: 通过 Web UI

1. 登录 Dokploy Web 界面
2. 进入 **设置** → **Web 服务器** → **更新**
3. 点击 **检查更新**
4. 如果有新版本，点击 **更新服务器** 按钮

---

## ⚠️ 重要：避免跨节点更新问题

**问题**：Docker Swarm 多节点环境下，更新可能导致服务迁移到新节点，出现 DNS 解析延迟问题。

**解决方案**：在更新前确保依赖服务稳定运行，并给足够时间让网络准备就绪。

### 安全升级流程（推荐）

```bash
# === 步骤 1: 检查当前状态 ===
echo "=== 检查当前服务状态 ==="
docker service ps dokploy
docker service ps dokploy-postgres
docker service ps dokploy-redis

# === 步骤 2: 确保依赖服务运行 ===
echo "=== 确保依赖服务运行 ==="
docker service update --replicas 1 dokploy-postgres 2>/dev/null || true
docker service update --replicas 1 dokploy-redis 2>/dev/null || true

# === 步骤 3: 等待依赖服务稳定（关键！）===
echo "=== 等待依赖服务稳定（30秒）==="
sleep 30

# === 步骤 4: 拉取新镜像 ===
echo "=== 拉取新镜像 ==="
docker pull a3180623/dokploy-i18n:latest

# === 步骤 5: 更新服务 ===
echo "=== 更新 Dokploy 服务 ==="
docker service update --force --image a3180623/dokploy-i18n:latest dokploy

# === 步骤 6: 等待服务启动（给足够时间）===
echo "=== 等待服务启动（40秒）==="
sleep 40

# === 步骤 7: 检查状态 ===
echo "=== 检查服务状态 ==="
docker service ps dokploy

# === 步骤 8: 查看日志 ===
echo "=== 查看最新日志 ==="
docker service logs dokploy --tail 50

# === 步骤 9: 验证访问 ===
echo "=== 验证服务访问 ==="
curl -v http://localhost:3000/api/health 2>&1 | head -20
```

---

## 🔍 故障排查与修复

### 问题 1: 服务更新后无法访问（数据库连接失败）

**症状**：
- 服务状态显示 `Running`
- 日志显示：`ENOTFOUND dokploy-postgres`
- 端口 3000 连接被拒绝

**原因**：Docker Swarm 跨节点更新时，DNS 解析延迟导致应用启动失败。

**修复步骤**：

```bash
# 1. 检查依赖服务
docker service ps dokploy-postgres
docker service ps dokploy-redis

# 2. 确保依赖服务运行
docker service update --replicas 1 dokploy-postgres
docker service update --replicas 1 dokploy-redis

# 3. 等待依赖服务稳定（重要！）
sleep 30

# 4. 验证网络连接
docker run --rm --network dokploy-network alpine \
  sh -c "nslookup dokploy-postgres && echo 'DNS OK'" || echo "DNS Failed"

# 5. 重启 dokploy 服务
docker service update --force dokploy

# 6. 等待服务启动（给足够时间）
sleep 40

# 7. 检查状态和日志
docker service ps dokploy
docker service logs dokploy --tail 50
```

### 问题 2: 服务不断重启

**检查**：
```bash
docker service ps dokploy --no-trunc
docker service logs dokploy --tail 100
```

**可能原因**：
- 配置错误
- 端口冲突
- 依赖服务未运行

**修复**：
```bash
# 检查端口占用
ss -tulnp | grep ':3000'

# 检查挂载路径
ls -la /var/run/docker.sock
ls -la /etc/dokploy

# 检查环境变量
docker service inspect dokploy --pretty | grep -A 30 "Env"
```

### 问题 3: 镜像拉取失败

**修复**：
```bash
# 重新拉取
docker pull a3180623/dokploy-i18n:latest

# 验证镜像
docker images | grep dokploy-i18n
docker inspect a3180623/dokploy-i18n:latest
```

---

## 🔄 回滚方案

### 快速回滚到之前的版本

```bash
# 1. 查看本地已有的镜像
docker images | grep dokploy-i18n

# 2. 选择要回滚的版本（例如 v0.25.14）
docker service update --force --image a3180623/dokploy-i18n:v0.25.14 dokploy

# 3. 等待服务恢复
sleep 30

# 4. 验证
docker service ps dokploy
docker service logs dokploy --tail 30
curl http://localhost:3000/api/health
```

### 如果不知道之前的版本

```bash
# 查看服务历史
docker service ps dokploy --no-trunc | head -10

# 从历史记录中找到之前使用的镜像标签
# 然后使用该标签回滚
```

### 完全重新安装（保留数据）

```bash
# 1. 停止服务
docker service scale dokploy=0

# 2. 备份配置（可选）
cp -r /etc/dokploy /etc/dokploy.backup

# 3. 重新运行安装脚本
bash install.sh update

# 注意：数据卷会保留，配置可能需要恢复
```

---

## 📊 升级验证清单

升级后请验证以下项目：

- [ ] 服务状态为 `Running`
  ```bash
  docker service ps dokploy
  ```

- [ ] 日志无错误信息
  ```bash
  docker service logs dokploy --tail 50 | grep -i error
  ```

- [ ] 端口可访问
  ```bash
  curl http://localhost:3000/api/health
  ```

- [ ] Web 界面可访问
  浏览器访问 `http://your-server-ip:3000`

- [ ] 功能正常
  登录后检查主要功能是否正常

---

## ❓ 常见问题

### Q1: 升级后 Web UI 显示"有更新"但实际已是最新？

**原因**：`RELEASE_TAG` 环境变量不匹配。

**解决**：
```bash
# 查看当前设置
docker service inspect dokploy --pretty | grep RELEASE_TAG

# 如果设置了固定版本，需要更新或移除
# 移除固定版本，使用 latest
docker service update --env-rm RELEASE_TAG dokploy

# 或者设置为当前版本
docker service update --env-add RELEASE_TAG=v0.25.15 dokploy
```

### Q2: 如何查看当前运行的版本？

```bash
# 方法 1: 查看服务使用的镜像
docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'

# 方法 2: 查看容器内的版本
docker ps | grep dokploy
docker exec -it <CONTAINER_ID> node -e "console.log(require('/app/package.json').version)"
```

### Q3: 升级会影响数据吗？

**不会**。升级只更新应用代码，数据存储在：
- 数据库：`dokploy-postgres` 卷
- 配置文件：`/etc/dokploy`
- 应用数据：各应用的数据卷

这些都不会被升级影响。

### Q4: 升级需要多长时间？

通常：
- 拉取镜像：10-60 秒（取决于网络）
- 服务更新：10-30 秒
- 应用启动：20-40 秒

总计：约 1-3 分钟，期间会有短暂的服务中断。

### Q5: 如何避免升级时的服务中断？

目前无法完全避免，因为：
- Docker Swarm 使用 `stop-first` 更新策略
- 需要先停止旧容器，再启动新容器

但可以：
- 在低峰期升级
- 使用负载均衡（如果有多个实例）
- 快速回滚（如遇问题）

---

## 📝 升级最佳实践

1. **升级前备份**
   ```bash
   # 备份配置
   cp -r /etc/dokploy /etc/dokploy.backup-$(date +%Y%m%d)
   
   # 记录当前版本
   docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' > current-version.txt
   ```

2. **在低峰期升级**：减少对用户的影响

3. **使用安全升级流程**：确保依赖服务稳定

4. **升级后验证**：按照验证清单检查

5. **保留回滚方案**：知道如何快速回滚

---

## 🎯 快速参考

### 一键安全升级脚本

```bash
#!/bin/bash
set -e

echo "=== Dokploy 安全升级脚本 ==="

# 检查依赖服务
echo "1. 检查依赖服务..."
docker service update --replicas 1 dokploy-postgres 2>/dev/null || true
docker service update --replicas 1 dokploy-redis 2>/dev/null || true

# 等待稳定
echo "2. 等待依赖服务稳定..."
sleep 30

# 拉取镜像
echo "3. 拉取最新镜像..."
docker pull a3180623/dokploy-i18n:latest

# 更新服务
echo "4. 更新服务..."
docker service update --force --image a3180623/dokploy-i18n:latest dokploy

# 等待启动
echo "5. 等待服务启动..."
sleep 40

# 验证
echo "6. 验证服务..."
docker service ps dokploy
docker service logs dokploy --tail 20

echo "=== 升级完成 ==="
```

保存为 `safe-update.sh`，运行：
```bash
chmod +x safe-update.sh
./safe-update.sh
```

---

**最后更新**: 2024年
**适用版本**: Dokploy v0.25.x+

