// 原料库默认数据。
//
// 字段：
//   group      'mine' 我的原料（配色时首选）/ 'generic' 通用参考颜料（仅在我的原料色域不足时作为补充建议）
//   kind       'color' 普通颜料参与混色求解；'effect' 珠光 / 变色龙粉，只做效果叠加，不参与色相求解
//   hex        颜料干燥后纯色（masstone）的近似屏幕色；效果粉为「正面主色」
//   hex2       仅效果粉：侧视 / 闪色
//   strength   着色力，越大越少量即可显色
//   opacity    遮盖力 0~1
//   binder     每 1g 原料需要额外加入的阿拉伯胶液克数（玛丽水彩本身已含胶，默认 0）
//   dose       仅效果粉：建议添加量，占基础原料质量的百分比
//   calibrated 色值是否已由用户用实物校准；false 表示仍是预设估计值
//
// 「我的原料」中的色值和名称都是按常见色卡排布做的预设估计，并不来自商品页面数据，
// 请在「配色生成」的「色卡校准」里用自己拍摄的色卡逐个校准。

const mine = {
  group: 'mine', kind: 'color', owned: true, preferred: true, calibrated: false,
};

// [名称, hex, 着色力, 遮盖力]
const MARIES_36 = [
  ['柠檬黄', '#F2D81A', 1.2, 0.3], ['中黄', '#F0B400', 1.2, 0.35], ['土黄', '#C58A2B', 0.8, 0.6],
  ['橘黄', '#E8821A', 1.1, 0.4], ['朱红', '#D8381E', 1.2, 0.4], ['大红', '#C41E2A', 1.2, 0.4],
  ['深红', '#8E1B2E', 1.3, 0.35], ['玫瑰红', '#C5245F', 1.4, 0.3], ['紫红', '#8E2A6E', 1.3, 0.3],
  ['青莲', '#5B3A8C', 1.3, 0.3], ['紫罗兰', '#4A3C96', 1.3, 0.3], ['群青', '#2B3A9A', 1.0, 0.3],
  ['钴蓝', '#2A5DAE', 0.9, 0.4], ['湖蓝', '#1F8FC6', 1.0, 0.4], ['天蓝', '#5AA9DB', 0.8, 0.5],
  ['普蓝', '#0F3566', 2.0, 0.3], ['孔雀蓝', '#0E8A9A', 1.2, 0.35], ['翠绿', '#1C8A5A', 1.1, 0.35],
  ['草绿', '#6BA43A', 1.0, 0.4], ['橄榄绿', '#6B7A2A', 1.0, 0.45], ['深绿', '#1E5B3A', 1.6, 0.3],
  ['粉绿', '#8CC9A0', 0.7, 0.7], ['熟褐', '#5A3320', 1.0, 0.5], ['赭石', '#A5622C', 0.9, 0.55],
  ['土红', '#9A4A33', 1.0, 0.6], ['生褐', '#6A5238', 1.0, 0.5], ['黑', '#1F1D1C', 1.5, 0.4],
  ['白', '#F5F4EE', 1.0, 1.0], ['肤色', '#EBB9A0', 0.6, 0.8], ['淡黄', '#F7E9A3', 0.6, 0.7],
  ['粉红', '#F0A3B5', 0.7, 0.7], ['橙红', '#E4572E', 1.2, 0.45], ['蓝绿', '#2FA58B', 1.0, 0.4],
  ['灰', '#8A8A88', 0.8, 0.6], ['赭黄', '#B8863A', 0.9, 0.55], ['柠檬绿', '#A7C93A', 1.0, 0.4],
];

export const MARIES_PIGMENTS = MARIES_36.map(([name, hex, strength, opacity], i) => ({
  id: `mm${String(i + 1).padStart(2, '0')}`,
  name: `玛丽 ${String(i + 1).padStart(2, '0')} ${name}`,
  code: '玛丽水彩',
  hex,
  strength,
  opacity,
  binder: 0,
  ...mine,
}));

const effect = {
  group: 'mine', kind: 'effect', owned: true, preferred: true, calibrated: false,
  strength: 1, opacity: 0.2, binder: 1.0,
};

// [名称, 正面主色, 侧视色, 建议添加量%]
const PEARLS = [
  ['白珍珠', '#F2F0EA', '#E6E2F2', 8], ['闪银', '#D9DADD', '#F4F4F6', 8], ['香槟金', '#E3CC9A', '#F3E4BC', 8],
  ['玫瑰金', '#E2A98F', '#F0C8B4', 8], ['红珠光', '#C8473C', '#E58A66', 8], ['蓝珠光', '#4A74C9', '#8FB0E8', 8],
  ['绿珠光', '#4FA277', '#92CDA8', 8], ['紫珠光', '#8A5BB5', '#BC98DA', 8],
];

// 5g 12 色光学变色龙粉（1688）；颜色对为常见搭配的预设估计，具体顺序以实物为准。
const CHAMELEONS = [
  ['紫 → 蓝', '#6A3FA0', '#2E5DC8'], ['蓝 → 紫', '#2A5AC8', '#8A3FB0'], ['绿 → 蓝', '#2FA070', '#2A6FC8'],
  ['绿 → 金', '#3FA060', '#C8A83A'], ['金 → 红', '#C8A83A', '#C8442E'], ['红 → 金', '#C8342E', '#D0A040'],
  ['橙 → 绿', '#E07A2A', '#4FA060'], ['紫 → 金', '#7A3FA0', '#C8A83A'], ['蓝 → 绿', '#2A5AC8', '#2FA070'],
  ['青 → 紫', '#20A0B0', '#7A3FA0'], ['粉 → 绿', '#D860A0', '#60B070'], ['铜 → 蓝', '#B8742E', '#2E5AA8'],
];

export const EFFECT_PIGMENTS = [
  ...PEARLS.map(([name, hex, hex2, dose], i) => ({
    id: `pearl${String(i + 1).padStart(2, '0')}`,
    name: `珠光粉 ${name}`,
    code: '拼多多链接（待核对）',
    hex,
    hex2,
    dose,
    subtype: 'pearl',
    ...effect,
  })),
  ...CHAMELEONS.map(([name, hex, hex2], i) => ({
    id: `cham${String(i + 1).padStart(2, '0')}`,
    name: `变色龙 ${String(i + 1).padStart(2, '0')} ${name}`,
    code: '1688 光学变色龙',
    hex,
    hex2,
    dose: 6,
    subtype: 'chameleon',
    ...effect,
  })),
];

// 通用参考颜料：默认不算「已有」，仅当我的原料凑不出目标色时，作为补充建议。
const generic = { group: 'generic', kind: 'color', owned: false, preferred: false, calibrated: true };

export const GENERIC_PIGMENTS = [
  { id: 'pw6', name: '钛白', code: 'PW6', hex: '#F4F3EE', strength: 1.0, opacity: 1.0, binder: 0.9 },
  { id: 'py3', name: '柠檬黄', code: 'PY3', hex: '#F3DA1C', strength: 1.2, opacity: 0.3, binder: 1.1 },
  { id: 'py74', name: '汉萨黄中', code: 'PY74', hex: '#F2B705', strength: 1.2, opacity: 0.3, binder: 1.1 },
  { id: 'py42', name: '土黄', code: 'PY42', hex: '#C98A2B', strength: 0.8, opacity: 0.7, binder: 0.8 },
  { id: 'po73', name: '橙', code: 'PO73', hex: '#E8501A', strength: 1.2, opacity: 0.6, binder: 1.0 },
  { id: 'pr254', name: '吡咯红', code: 'PR254', hex: '#C8201E', strength: 1.3, opacity: 0.5, binder: 1.0 },
  { id: 'pv19', name: '喹吖啶酮玫红', code: 'PV19', hex: '#B31E5A', strength: 1.5, opacity: 0.2, binder: 1.2 },
  { id: 'pr101', name: '氧化铁红', code: 'PR101', hex: '#8A2A22', strength: 1.0, opacity: 0.7, binder: 0.8 },
  { id: 'pbr7s', name: '熟赭（熟褐红）', code: 'PBr7', hex: '#8E3F1F', strength: 1.0, opacity: 0.5, binder: 0.8 },
  { id: 'pbr7r', name: '生赭', code: 'PBr7', hex: '#B0742B', strength: 0.9, opacity: 0.5, binder: 0.8 },
  { id: 'pbr7bu', name: '熟褐', code: 'PBr7', hex: '#4A2C1C', strength: 1.0, opacity: 0.5, binder: 0.8 },
  { id: 'pbr7ru', name: '生褐', code: 'PBr7', hex: '#5E4A33', strength: 1.0, opacity: 0.5, binder: 0.8 },
  { id: 'pb29', name: '群青', code: 'PB29', hex: '#2B3A9A', strength: 0.8, opacity: 0.3, binder: 1.3 },
  { id: 'pb28', name: '钴蓝', code: 'PB28', hex: '#1F5FB0', strength: 0.7, opacity: 0.4, binder: 1.0 },
  { id: 'pb35', name: '天蓝', code: 'PB35', hex: '#2C86C8', strength: 0.7, opacity: 0.6, binder: 0.9 },
  { id: 'pb15', name: '酞菁蓝', code: 'PB15:3', hex: '#0B2F6B', strength: 3.0, opacity: 0.2, binder: 1.3 },
  { id: 'pg7', name: '酞菁绿', code: 'PG7', hex: '#0B5A43', strength: 3.0, opacity: 0.2, binder: 1.3 },
  { id: 'pg18', name: '翠绿（铬绿）', code: 'PG18', hex: '#1E7F6A', strength: 0.8, opacity: 0.3, binder: 1.0 },
  { id: 'pv23', name: '二噁嗪紫', code: 'PV23', hex: '#3B1D6B', strength: 3.0, opacity: 0.2, binder: 1.3 },
  { id: 'pbk9', name: '象牙黑', code: 'PBk9', hex: '#1E1B1A', strength: 1.0, opacity: 0.4, binder: 1.2 },
].map((p) => ({ ...generic, ...p }));

export const DEFAULT_PIGMENTS = [...MARIES_PIGMENTS, ...EFFECT_PIGMENTS, ...GENERIC_PIGMENTS];

// 把已保存的原料库与当前默认库合并：补齐新增的默认项，并给旧数据补上分组字段，不覆盖用户的修改。
export function migratePigments(saved, defaults = DEFAULT_PIGMENTS) {
  if (!Array.isArray(saved)) return defaults.map((p) => ({ ...p }));
  const known = new Set(saved.map((p) => p.id));
  const upgraded = saved.map((p) => ({
    group: 'generic', kind: 'color', preferred: false, calibrated: true, ...p,
  }));
  const added = defaults.filter((p) => !known.has(p.id)).map((p) => ({ ...p }));
  return [...upgraded, ...added];
}

// 辅料按「相对基础原料总质量的百分比」计算，仅为常见起点，需结合实际手感调整。
export const DEFAULT_ADDITIVES = [
  { name: '蜂蜜', ratio: 8 },
  { name: '甘油', ratio: 4 },
  { name: '丁香油 / 防腐剂', ratio: 1 },
];

export const DEFAULT_BINDER_NAME = '阿拉伯胶液';
