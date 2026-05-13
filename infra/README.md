# Infra

本地开发依赖的基础设施：PostgreSQL / Redis / MinIO。

```bash
docker compose -f infra/docker-compose.yml up -d
```

| 服务 | 端口 | 凭据 |
|------|------|------|
| PostgreSQL | 5432 | agenthub / agenthub |
| Redis | 6379 | — |
| MinIO S3 API | 9000 | minioadmin / minioadmin |
| MinIO 控制台 | 9001 | minioadmin / minioadmin |

启动后 `agenthub` bucket 会自动创建。

停止：
```bash
docker compose -f infra/docker-compose.yml down
```

清理数据（**会删数据**）：
```bash
docker compose -f infra/docker-compose.yml down -v
```
