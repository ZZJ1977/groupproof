"""统一认证模块（自独立 server/ 迁移，PLAN：统一认证后端 + Resend）。

- 团队 users 表（UUID）是唯一身份来源；认证附属表通过 user_id 外键关联。
- 会话、CSRF、限流、注册、学校邮箱验证、教师审核、密码恢复与审计均在此模块。
- 业务模块通过 app.api.auth.get_current_user 取得真实会话用户。
"""
