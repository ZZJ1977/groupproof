"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Archived = { id: string; name: string; archived_at: string | null };

export function CourseReopenApiPage({ courseId }: { courseId: string }) {
  const [items, setItems] = useState<Archived[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    fetch(`/api/v1/courses/${courseId}/reopenable-projects`, { credentials: "include", cache: "no-store" })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? "读取失败"); return result.data as Archived[]; })
      .then((result) => { if (active) setItems(result); })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [courseId]);
  return <main className="space-y-4 p-6"><h1 className="text-2xl font-semibold">重新开启课程项目</h1>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    {items.map((item) => <p key={item.id}>{item.name} · {item.archived_at ?? "已归档"} · <Link className="text-blue-700" href={`/projects/${item.id}/settings`}>选择项目并重新开启</Link></p>)}
    {!items.length && <p>暂无已归档项目。</p>}
  </main>;
}
