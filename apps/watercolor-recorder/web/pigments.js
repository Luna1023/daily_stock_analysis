// 默认原料库。hex 为干燥后纯色（masstone）的近似屏幕色，仅作起点，
// 建议用自己拍摄的色块在「原料库」中校准。
// strength: 着色力（越大越少量即可显色）；opacity: 遮盖力 0~1；binder: 每 1g 颜料需要的阿拉伯胶液克数。

export const DEFAULT_PIGMENTS = [
  { id: 'pw6', name: '钛白', code: 'PW6', hex: '#F4F3EE', strength: 1.0, opacity: 1.0, binder: 0.9, owned: true },
  { id: 'py3', name: '柠檬黄', code: 'PY3', hex: '#F3DA1C', strength: 1.2, opacity: 0.3, binder: 1.1, owned: true },
  { id: 'py74', name: '汉萨黄中', code: 'PY74', hex: '#F2B705', strength: 1.2, opacity: 0.3, binder: 1.1, owned: true },
  { id: 'py42', name: '土黄', code: 'PY42', hex: '#C98A2B', strength: 0.8, opacity: 0.7, binder: 0.8, owned: true },
  { id: 'po73', name: '橙', code: 'PO73', hex: '#E8501A', strength: 1.2, opacity: 0.6, binder: 1.0, owned: true },
  { id: 'pr254', name: '吡咯红', code: 'PR254', hex: '#C8201E', strength: 1.3, opacity: 0.5, binder: 1.0, owned: true },
  { id: 'pv19', name: '喹吖啶酮玫红', code: 'PV19', hex: '#B31E5A', strength: 1.5, opacity: 0.2, binder: 1.2, owned: true },
  { id: 'pr101', name: '氧化铁红', code: 'PR101', hex: '#8A2A22', strength: 1.0, opacity: 0.7, binder: 0.8, owned: true },
  { id: 'pbr7s', name: '熟赭（熟褐红）', code: 'PBr7', hex: '#8E3F1F', strength: 1.0, opacity: 0.5, binder: 0.8, owned: true },
  { id: 'pbr7r', name: '生赭', code: 'PBr7', hex: '#B0742B', strength: 0.9, opacity: 0.5, binder: 0.8, owned: true },
  { id: 'pbr7bu', name: '熟褐', code: 'PBr7', hex: '#4A2C1C', strength: 1.0, opacity: 0.5, binder: 0.8, owned: true },
  { id: 'pbr7ru', name: '生褐', code: 'PBr7', hex: '#5E4A33', strength: 1.0, opacity: 0.5, binder: 0.8, owned: true },
  { id: 'pb29', name: '群青', code: 'PB29', hex: '#2B3A9A', strength: 0.8, opacity: 0.3, binder: 1.3, owned: true },
  { id: 'pb28', name: '钴蓝', code: 'PB28', hex: '#1F5FB0', strength: 0.7, opacity: 0.4, binder: 1.0, owned: true },
  { id: 'pb35', name: '天蓝', code: 'PB35', hex: '#2C86C8', strength: 0.7, opacity: 0.6, binder: 0.9, owned: true },
  { id: 'pb15', name: '酞菁蓝', code: 'PB15:3', hex: '#0B2F6B', strength: 3.0, opacity: 0.2, binder: 1.3, owned: true },
  { id: 'pg7', name: '酞菁绿', code: 'PG7', hex: '#0B5A43', strength: 3.0, opacity: 0.2, binder: 1.3, owned: true },
  { id: 'pg18', name: '翠绿（铬绿）', code: 'PG18', hex: '#1E7F6A', strength: 0.8, opacity: 0.3, binder: 1.0, owned: true },
  { id: 'pv23', name: '二噁嗪紫', code: 'PV23', hex: '#3B1D6B', strength: 3.0, opacity: 0.2, binder: 1.3, owned: true },
  { id: 'pbk9', name: '象牙黑', code: 'PBk9', hex: '#1E1B1A', strength: 1.0, opacity: 0.4, binder: 1.2, owned: true },
];

// 辅料按「相对颜料总质量的百分比」计算，仅为常见起点，需结合实际手感调整。
export const DEFAULT_ADDITIVES = [
  { name: '蜂蜜', ratio: 8 },
  { name: '甘油', ratio: 4 },
  { name: '丁香油 / 防腐剂', ratio: 1 },
];

export const DEFAULT_BINDER_NAME = '阿拉伯胶液';
