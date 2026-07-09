export const DEFAULT_PET_KIND = "shiba";

export const PET_KINDS = [
  {
    id: "shiba",
    label: "柴犬 Papo",
    description: "暖橙色柴犬，亲近、活泼，适合默认陪伴。",
    renderer: "shiba",
    speciesNoun: "小狗",
    appearance: "可爱的卡通柴犬，暖橙和奶白毛色，圆润脸颊，友好的表情，身体小巧结实。",
    imagePrompt: "premium semi-realistic 3D mobile companion mascot, cute Shiba Inu dog, warm orange and cream fur, rounded cheeks, friendly natural eyes, clean full-body character reference, warm off-white studio background",
    registrationImage: "pets/register/shiba.jpg",
    accentColor: "#e89a42"
  },
  {
    id: "british-shorthair",
    label: "英短短",
    description: "灰白英短小猫，圆脸大眼，安静温柔。",
    renderer: "generated",
    speciesNoun: "小猫",
    appearance: "圆脸灰白英短小猫，蓝灰和白色毛色，琥珀色眼睛，小粉鼻，身体柔软微胖。",
    imagePrompt: "premium semi-realistic 3D mobile companion mascot, round-faced gray and white British Shorthair kitten, amber eyes, tiny pink nose, soft paws, clean full-body character reference, warm off-white studio background",
    registrationImage: "pets/register/british-shorthair.webp",
    registrationVideo: "pets/generated/british-shorthair-v1/idle.mp4",
    accentColor: "#8fa0a5"
  },
  {
    id: "golden-retriever",
    label: "金毛犬",
    description: "金色小狗，热情可靠，像会一直陪你散步。",
    renderer: "template",
    speciesNoun: "小狗",
    appearance: "幼年金毛寻回犬，金色柔顺毛发，黑亮鼻子，温和眼睛，耳朵自然垂下，表情开朗可信赖。",
    imagePrompt: "premium semi-realistic 3D mobile companion mascot, young Golden Retriever puppy, soft golden fur, warm brown eyes, black nose, floppy ears, clean full-body character reference, warm off-white studio background",
    registrationImage: "pets/register/golden-retriever.jpg",
    registrationVideo: "pets/register/golden-retriever.mp4",
    accentColor: "#d9a64f"
  },
  {
    id: "ragdoll-cat",
    label: "布偶猫",
    description: "奶白长毛小猫，蓝眼睛，柔软黏人。",
    renderer: "template",
    speciesNoun: "小猫",
    appearance: "奶白色布偶小猫，柔软长毛，浅棕耳朵和尾巴，蓝色眼睛，脸颊圆润，姿态温顺。",
    imagePrompt: "premium semi-realistic 3D mobile companion mascot, fluffy Ragdoll kitten, cream white long fur, soft brown ears and tail, blue eyes, rounded cheeks, clean full-body character reference, warm off-white studio background",
    registrationImage: "pets/register/ragdoll-cat.jpg",
    registrationVideo: "pets/register/ragdoll-cat.mp4",
    accentColor: "#c8a88a"
  },
  {
    id: "lop-rabbit",
    label: "垂耳兔",
    description: "奶白小兔，动作轻，适合安静陪伴。",
    renderer: "template",
    speciesNoun: "小兔",
    appearance: "奶白色垂耳小兔，耳朵柔软下垂，圆眼睛，短短尾巴，身体圆润，动作轻柔安静。",
    imagePrompt: "premium semi-realistic 3D mobile companion mascot, tiny cream white lop-eared rabbit, floppy ears, round gentle eyes, soft rounded body, clean full-body character reference, warm off-white studio background",
    registrationImage: "pets/register/lop-rabbit.jpg",
    registrationVideo: "pets/register/lop-rabbit.mp4",
    accentColor: "#d7b7c3"
  },
  {
    id: "hamster",
    label: "小仓鼠",
    description: "圆滚滚的小仓鼠，好奇、可爱，适合记录小事。",
    renderer: "template",
    speciesNoun: "仓鼠",
    appearance: "金白色小仓鼠，圆滚滚身体，小耳朵，黑亮眼睛，粉色小爪，脸颊鼓鼓的。",
    imagePrompt: "premium semi-realistic 3D mobile companion mascot, tiny golden and white hamster, round chubby body, tiny ears, bright black eyes, pink paws, full-body character reference, warm off-white studio background",
    registrationImage: "pets/register/hamster.jpg",
    registrationVideo: "pets/register/hamster.mp4",
    accentColor: "#d5a65b"
  },
  {
    id: "cockatiel",
    label: "玄凤鹦鹉",
    description: "浅黄小鸟，精神、机灵，会轻轻回应你。",
    renderer: "template",
    speciesNoun: "小鸟",
    appearance: "浅黄色玄凤鹦鹉，橙色脸颊，头顶小冠羽，灰白翅膀，眼神机灵，身体小巧。",
    imagePrompt: "premium semi-realistic 3D mobile companion mascot, small pale yellow cockatiel bird, orange cheek patches, cute crest feathers, gray-white wings, bright eyes, full-body character reference, warm off-white studio background",
    registrationImage: "pets/register/cockatiel.jpg",
    registrationVideo: "pets/register/cockatiel.mp4",
    accentColor: "#e7c95f"
  }
] as const;

export type PetKindId = (typeof PET_KINDS)[number]["id"];
export type PetKindRenderer = (typeof PET_KINDS)[number]["renderer"];

export function normalizePetKind(value?: string): PetKindId {
  return PET_KINDS.some((pet) => pet.id === value) ? (value as PetKindId) : DEFAULT_PET_KIND;
}

export function petKindMeta(value?: string) {
  return PET_KINDS.find((item) => item.id === normalizePetKind(value)) ?? PET_KINDS[0];
}

export function petKindLabel(value?: string) {
  return petKindMeta(value).label;
}
