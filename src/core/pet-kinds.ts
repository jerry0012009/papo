export const DEFAULT_PET_KIND = "shiba";

export const PET_KINDS = [
  { id: "shiba", label: "柴犬 Papo", description: "默认的小狗形象，适合温暖陪伴。", renderer: "shiba" },
  { id: "claude", label: "Claude", description: "小小的橙色方块宠物，表情丰富。", renderer: "agent-pet" },
  { id: "codex", label: "Codex", description: "经典桌面小伙伴，适合专注工作。", renderer: "agent-pet" },
  { id: "datawhale", label: "DataWhale", description: "圆滚滚的小鲸鱼，安静柔和。", renderer: "agent-pet" },
  { id: "dewey", label: "Dewey", description: "整洁的小鸭子，适合平稳陪伴。", renderer: "agent-pet" },
  { id: "fireball", label: "Fireball", description: "活跃的小火球，反应更有能量。", renderer: "agent-pet" },
  { id: "mo-xia", label: "Mo Xia", description: "戴斗笠的小侠客，安静但有存在感。", renderer: "agent-pet" },
  { id: "rocky", label: "Rocky", description: "稳稳的小石头，适合慢慢陪着。", renderer: "agent-pet" },
  { id: "seedy", label: "Seedy", description: "冒芽的小植物，适合记录新想法。", renderer: "agent-pet" },
  { id: "stacky", label: "Stacky", description: "叠叠的小伙伴，适合整理和复盘。", renderer: "agent-pet" },
  { id: "british-shorthair", label: "英短短", description: "灰白英短小猫咪，圆脸大眼，安静温柔。", renderer: "generated" }
] as const;

export type PetKindId = (typeof PET_KINDS)[number]["id"];

export function normalizePetKind(value?: string): PetKindId {
  return PET_KINDS.some((pet) => pet.id === value) ? (value as PetKindId) : DEFAULT_PET_KIND;
}

export function petKindLabel(value?: string) {
  const pet = PET_KINDS.find((item) => item.id === normalizePetKind(value));
  return pet?.label ?? "Papo";
}
