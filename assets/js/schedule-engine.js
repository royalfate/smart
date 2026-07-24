export const DAY_MS = 86400000;

export function localDate(value = new Date()) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value || "").slice(0, 10);
}

export const dateAt = (value) => new Date(`${localDate(value)}T00:00:00`);
export const diffDays = (a, b) => Math.round((dateAt(b) - dateAt(a)) / DAY_MS);
export const clamp = (number, min, max) => Math.max(min, Math.min(max, Number(number) || 0));

export function plannedRate(item, baseDate = new Date()) {
  const start = dateAt(item.start);
  const end = dateAt(item.end);
  const total = Math.max(1, diffDays(item.start, item.end) + 1);
  return clamp((diffDays(start, baseDate) + 1) / total * 100, 0, 100);
}

export function taskDelayDays(item, baseDate = new Date()) {
  const planned = plannedRate(item, baseDate);
  const actual = clamp(item.actual, 0, 100);
  if (planned <= actual || planned <= 0) return 0;
  const duration = Math.max(1, diffDays(item.start, item.end) + 1);
  return Math.max(1, Math.ceil((planned - actual) / 100 * duration));
}

export function aggregateGroups(tasks, baseDate = new Date()) {
  const groups = new Map();
  tasks.forEach((item) => {
    if (!groups.has(item.group)) {
      groups.set(item.group, {
        id: item.group.split(" ")[0],
        name: item.group.replace(/^\d+\s*/, ""),
        group: item.group,
        cost: 0,
        start: item.start,
        end: item.end,
        weightedPlan: 0,
        weightedActual: 0,
        delayDays: 0,
        delayedTasks: 0,
        children: [],
      });
    }
    const group = groups.get(item.group);
    group.children.push(item);
    group.cost += Math.max(0, Number(item.cost) || 0);
    if (dateAt(item.start) < dateAt(group.start)) group.start = item.start;
    if (dateAt(item.end) > dateAt(group.end)) group.end = item.end;
  });
  return [...groups.values()].map((group) => {
    const denominator = group.cost || group.children.length || 1;
    group.children.forEach((item) => {
      const weight = group.cost ? Math.max(0, Number(item.cost) || 0) : 1;
      group.weightedPlan += plannedRate(item, baseDate) * weight;
      group.weightedActual += clamp(item.actual, 0, 100) * weight;
      const delay = taskDelayDays(item, baseDate);
      group.delayDays = Math.max(group.delayDays, delay);
      if (delay > 0) group.delayedTasks += 1;
    });
    group.plan = group.weightedPlan / denominator;
    group.actual = group.weightedActual / denominator;
    return group;
  });
}

export function summarizeSchedule(tasks, baseDate = new Date()) {
  const totalCost = tasks.reduce((sum, item) => sum + Math.max(0, Number(item.cost) || 0), 0);
  const denominator = totalCost || tasks.length || 1;
  let plan = 0;
  let actual = 0;
  let delayDays = 0;
  let delayedTasks = 0;
  tasks.forEach((item) => {
    const weight = totalCost ? Math.max(0, Number(item.cost) || 0) : 1;
    plan += plannedRate(item, baseDate) * weight;
    actual += clamp(item.actual, 0, 100) * weight;
    const delay = taskDelayDays(item, baseDate);
    delayDays = Math.max(delayDays, delay);
    if (delay > 0) delayedTasks += 1;
  });
  return {
    totalCost,
    plan: plan / denominator,
    actual: actual / denominator,
    variance: (actual - plan) / denominator,
    delayDays,
    delayedTasks,
  };
}

export function validateSchedule(tasks, expectedTotal) {
  const ids = new Set();
  const errors = [];
  tasks.forEach((item) => {
    if (!item.id || ids.has(item.id)) errors.push(`중복 또는 누락 WBS: ${item.id || "없음"}`);
    ids.add(item.id);
    if (!item.group || !item.name) errors.push(`${item.id}: 공종명이 없습니다.`);
    if (dateAt(item.end) < dateAt(item.start)) errors.push(`${item.id}: 종료일이 시작일보다 빠릅니다.`);
  });
  const total = tasks.reduce((sum, item) => sum + Math.max(0, Number(item.cost) || 0), 0);
  if (expectedTotal && total !== expectedTotal) errors.push(`직접공사비 합계 불일치: ${total}`);
  return errors;
}
