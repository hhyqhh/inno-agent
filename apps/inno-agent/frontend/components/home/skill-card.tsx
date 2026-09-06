"use client";

import {
  Notebook,
  GraduationCap,
  ClipboardCheck,
  FlaskConical,
  ArrowRight,
} from "lucide-react";

const CARDS = [
  {
    id: "beike",
    title: "备课",
    desc: "课件生成、教学设计、试题命制一站完成",
    icon: Notebook,
    tint: "from-[#6366F1]/12 to-[#a78bfa]/12 text-[#6366F1]",
  },
  {
    id: "xuexi",
    title: "学习",
    desc: "个性化学习路径、答疑伴学与难题拆解",
    icon: GraduationCap,
    tint: "from-emerald-500/12 to-teal-500/12 text-emerald-600",
  },
  {
    id: "pingjia",
    title: "评价",
    desc: "学情诊断、课堂分析与评价量规设计",
    icon: ClipboardCheck,
    tint: "from-sky-500/12 to-blue-500/12 text-sky-600",
  },
  {
    id: "keyan",
    title: "科研",
    desc: "文献检索、课题研究与知识体系分析",
    icon: FlaskConical,
    tint: "from-rose-500/12 to-pink-500/12 text-rose-500",
  },
];

export function SkillCards() {
  return (
    <div className="mx-auto grid w-full max-w-4xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {CARDS.map((c) => (
        <button
          key={c.id}
          type="button"
          className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/30 hover:bg-accent/40"
        >
          <span
            className={`flex size-9 items-center justify-center rounded-lg bg-gradient-to-br ${c.tint}`}
          >
            <c.icon className="size-5" />
          </span>
          <span className="flex items-center gap-1 text-sm font-medium text-foreground">
            {c.title}
            <ArrowRight className="size-3.5 text-muted-foreground/50" />
          </span>
          <span className="text-xs leading-5 text-muted-foreground">{c.desc}</span>
        </button>
      ))}
    </div>
  );
}
