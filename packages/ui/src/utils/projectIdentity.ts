export interface ProjectIdentitySettings {
  name?: string;
  color?: string;
}

export interface ResolvedProjectIdentity {
  name: string;
  color: string;
}

const DEFAULT_PROJECT_NAME = 'Stoneforge';
const DEFAULT_PROJECT_COLOR = '#2563eb';

function normalizeProjectName(name?: string): string {
  if (!name) return DEFAULT_PROJECT_NAME;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_PROJECT_NAME;
}

function normalizeProjectColor(color?: string): string {
  if (!color) return DEFAULT_PROJECT_COLOR;
  const trimmed = color.trim();
  if (!/^#([0-9a-fA-F]{6})$/.test(trimmed)) {
    return DEFAULT_PROJECT_COLOR;
  }
  return trimmed.toLowerCase();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const r1 = r / 255;
  const g1 = g / 255;
  const b1 = b / 255;
  const max = Math.max(r1, g1, b1);
  const min = Math.min(r1, g1, b1);
  const delta = max - min;

  let h = 0;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  if (delta !== 0) {
    if (max === r1) {
      h = 60 * (((g1 - b1) / delta) % 6);
    } else if (max === g1) {
      h = 60 * ((b1 - r1) / delta + 2);
    } else {
      h = 60 * ((r1 - g1) / delta + 4);
    }
  }

  return {
    h: h < 0 ? h + 360 : h,
    s,
    l,
  };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (h >= 0 && h < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (h >= 60 && h < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (h >= 120 && h < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (h >= 180 && h < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (h >= 240 && h < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  return {
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mixWithWhite(hex: string, ratio: number): string {
  const { r, g, b } = hexToRgb(hex);
  const w = 255;
  return rgbToHex(
    r + (w - r) * ratio,
    g + (w - g) * ratio,
    b + (w - b) * ratio,
  );
}

function mixWithBlack(hex: string, ratio: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(
    r * (1 - ratio),
    g * (1 - ratio),
    b * (1 - ratio),
  );
}

function alpha(hex: string, opacity: number): string {
  const { r, g, b } = hexToRgb(hex);
  const a = clamp01(opacity);
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

export function resolveProjectIdentity(settings?: ProjectIdentitySettings): ResolvedProjectIdentity {
  return {
    name: normalizeProjectName(settings?.name),
    color: normalizeProjectColor(settings?.color),
  };
}

function generatePrimaryScale(baseHex: string): Record<number, string> {
  return {
    50: mixWithWhite(baseHex, 0.92),
    100: mixWithWhite(baseHex, 0.82),
    200: mixWithWhite(baseHex, 0.68),
    300: mixWithWhite(baseHex, 0.5),
    400: mixWithWhite(baseHex, 0.28),
    500: baseHex,
    600: mixWithBlack(baseHex, 0.18),
    700: mixWithBlack(baseHex, 0.32),
    800: mixWithBlack(baseHex, 0.46),
    900: mixWithBlack(baseHex, 0.58),
    950: mixWithBlack(baseHex, 0.72),
  };
}

export function applyProjectAccentColor(color: string): void {
  if (typeof document === 'undefined') {
    return;
  }

  const resolved = normalizeProjectColor(color);
  const scale = generatePrimaryScale(resolved);
  const root = document.documentElement;

  for (const [shade, value] of Object.entries(scale)) {
    root.style.setProperty(`--color-primary-${shade}`, value);
  }

  root.style.setProperty('--color-primary', scale[600]);
  root.style.setProperty('--color-primary-hover', scale[700]);
  root.style.setProperty('--color-primary-active', scale[800]);
  root.style.setProperty('--color-primary-text', scale[600]);
  root.style.setProperty('--color-primary-muted', alpha(scale[600], 0.15));
}

function initialsFromProjectName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function getOrCreateFaviconLink(rel: string): HTMLLinkElement {
  const existing = document.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
  if (existing) return existing;

  const link = document.createElement('link');
  link.rel = rel;
  document.head.appendChild(link);
  return link;
}

export function applyProjectFavicon(name: string, color: string): void {
  if (typeof document === 'undefined') {
    return;
  }

  const resolvedName = normalizeProjectName(name);
  const resolvedColor = normalizeProjectColor(color);
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return;
  }

  const initials = initialsFromProjectName(resolvedName);
  const { r, g, b } = hexToRgb(resolvedColor);
  const hsl = rgbToHsl(r, g, b);
  const adjusted = hslToRgb(hsl.h, clamp01(hsl.s + 0.05), clamp01(hsl.l));
  const circleColor = rgbToHex(adjusted.r, adjusted.g, adjusted.b);

  ctx.clearRect(0, 0, 32, 32);
  ctx.beginPath();
  ctx.arc(16, 16, 15, 0, Math.PI * 2);
  ctx.fillStyle = circleColor;
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = `${initials.length > 1 ? '700 13px' : '700 16px'} system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials, 16, 16.5);

  const faviconDataUrl = canvas.toDataURL('image/png');
  const icon = getOrCreateFaviconLink('icon');
  const shortcut = getOrCreateFaviconLink('shortcut icon');
  icon.type = 'image/png';
  icon.href = faviconDataUrl;
  shortcut.type = 'image/png';
  shortcut.href = faviconDataUrl;
}

export function applyProjectIdentity(settings?: ProjectIdentitySettings): ResolvedProjectIdentity {
  const resolved = resolveProjectIdentity(settings);
  applyProjectAccentColor(resolved.color);
  applyProjectFavicon(resolved.name, resolved.color);
  return resolved;
}
