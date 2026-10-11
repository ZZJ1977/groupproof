"use client";

import { useQuery } from "@tanstack/react-query";
import { createCClient, CApiError, type AdminUserQuery } from "@/lib/api/c-client";
import { useWorkspace } from "@/lib/workspace";
import { Box, Empty, Header, Table } from "@/features/governance/primitives";
import styles from "@/features/governance/governance.module.css";
import { useUrlQuery } from "./use-url-query";

const client = createCClient();
const roles = { student: "学生", teacher: "教师", ta: "助教", admin: "管理员" } as const;
const statuses = { active: "正常", disabled: "已停用", pending: "待审核" } as const;
function errorMessage(error: Error | null) {
  if (error instanceof CApiError) {
    if (error.status === 401) return "需要有效的管理员登录身份，当前无法读取用户目录。";
    if (error.status === 403) return "只有有效的管理员账户可以读取用户目录。";
    return `${error.message}${error.requestId ? `（请求编号：${error.requestId}）` : ""}`;
  }
  return "用户目录暂不可用，请重试。";
}

/** Reads only canonical server DTOs. Never merges mock accounts into this directory. */
export function AdminUserDirectory() {
  const { userId } = useWorkspace();
  const { query, updateQuery } = useUrlQuery();
  const rawPage = Number(query.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 1_000_000 ? rawPage : 1;
  const role = query.get("role") as keyof typeof roles | null;
  const status = query.get("status") as keyof typeof statuses | null;
  const filters: AdminUserQuery = { page, page_size: 10, q: query.get("q") || undefined,
    name: query.get("name") || undefined, email: query.get("email") || undefined,
    student_id: query.get("student_id") || undefined, college: query.get("college") || undefined,
    role: role && Object.hasOwn(roles, role) ? role : undefined,
    status: status && Object.hasOwn(statuses, status) ? status : undefined };
  const list = useQuery({ queryKey: ["c-admin-users", userId, filters], queryFn: () => client.adminUsers(filters), staleTime: 0, gcTime: 0, retry: false });
  const selectedId = query.get("user");
  const detail = useQuery({ queryKey: ["c-admin-user", userId, selectedId], queryFn: () => client.adminUser(selectedId!), enabled: Boolean(selectedId) && list.isSuccess && !list.isFetching, staleTime: 0, gcTime: 0, retry: false });
  const result = list.isSuccess && !list.isFetching ? list.data : undefined;
  return <div className={styles.page}>
    <Header title="用户管理" description="按服务器权限查询用户基本资料，每页 10 条。" />
    <form key={query.toString()} className={styles.filters} onSubmit={(event) => {
      event.preventDefault(); const input = new FormData(event.currentTarget);
      const next = Object.fromEntries(["q", "name", "email", "student_id", "college", "role", "status"].map((key) => [key, String(input.get(key) ?? "").trim() || null]));
      updateQuery({ ...next, page: null, user: null });
    }}>
      {[["q", "综合搜索", 320], ["name", "姓名", 120], ["email", "邮箱", 320], ["student_id", "学号", 80], ["college", "学院", 160]].map(([name, label, max]) => <label key={name} className={styles.field}>{label}<input className={styles.input} name={String(name)} defaultValue={query.get(String(name)) ?? ""} maxLength={Number(max)} /></label>)}
      <label className={styles.field}>角色<select className={styles.select} name="role" defaultValue={filters.role ?? ""}><option value="">全部角色</option>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className={styles.field}>状态<select className={styles.select} name="status" defaultValue={filters.status ?? ""}><option value="">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className={styles.primaryButton} type="submit">查询</button>
      <button className={styles.button} type="button" onClick={() => updateQuery({ q: null, name: null, email: null, student_id: null, college: null, role: null, status: null, page: null, user: null })}>重置</button>
    </form>
    {list.isFetching && <p role="status">正在读取用户目录…</p>}
    {list.isError && <div role="alert"><p>{errorMessage(list.error)}</p><button className={styles.button} type="button" onClick={() => void list.refetch()}>重试</button></div>}
    {result && <Box><Table><thead><tr><th>姓名</th><th>学号 / 用户名</th><th>邮箱</th><th>学院</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{result.items.map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.student_id ?? item.username}</td><td>{item.email}</td><td>{item.college}</td><td>{roles[item.global_role]}</td><td>{statuses[item.status]}</td><td><button type="button" className={styles.button} onClick={() => updateQuery({ user: item.id })}>查看</button></td></tr>)}</tbody></Table>
      {!result.items.length && <Empty />}
      <div className={styles.tableFooter}><span>共 {result.total} 条 · 第 {result.page} 页</span><div className={styles.actions}><button className={styles.button} type="button" disabled={page <= 1} onClick={() => updateQuery({ page: String(page - 1), user: null })}>上一页</button><button className={styles.button} type="button" disabled={page * 10 >= result.total} onClick={() => updateQuery({ page: String(page + 1), user: null })}>下一页</button></div></div>
    </Box>}
    {selectedId && result && <Box title="用户详情" action={<button className={styles.button} type="button" onClick={() => updateQuery({ user: null })}>关闭</button>}><div className={styles.panelBody}>
      {detail.isFetching && <p role="status">正在读取详情…</p>}{detail.isError && <div role="alert"><p>{errorMessage(detail.error)}</p><button className={styles.button} type="button" onClick={() => void detail.refetch()}>重试详情</button></div>}
      {detail.isSuccess && !detail.isFetching && <dl><dt>姓名</dt><dd>{detail.data.name}</dd><dt>邮箱</dt><dd>{detail.data.email}</dd><dt>邮箱验证</dt><dd>{detail.data.email_verified ? "已验证" : "未验证"}</dd><dt>角色</dt><dd>{roles[detail.data.global_role]}</dd><dt>状态</dt><dd>{statuses[detail.data.status]}</dd></dl>}
    </div></Box>}
  </div>;
}
