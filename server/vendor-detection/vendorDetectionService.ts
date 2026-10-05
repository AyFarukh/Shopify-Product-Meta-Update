import { DEFAULT_ALIASES, DEFAULT_KNOWN_VENDORS, GENERIC_WORDS } from './vendors.js';
import { normalizeProductTitle } from './normalizeProductTitle.js';

export type DetectionStatus = 'HIGH_CONFIDENCE'|'REVIEW_RECOMMENDED'|'REVIEW_REQUIRED'|'NO_VENDOR_FOUND'|'ALREADY_CORRECT'|'CONFLICT';
export type DetectionResult = { vendor: string|null; confidence: number; reason: string; source: string; status: DetectionStatus };
export type VendorRuleInput = { matchType: 'Contains'|'Starts With'|'Exact'|'Regex'|'Alias'; matchValue: string; vendor: string; priority?: number; enabled?: boolean };
export type DetectionContext = { knownVendors?: string[]; aliases?: Record<string,string>; rules?: VendorRuleInput[]; genericVendors?: string[]; existingVendors?: string[] };

const boundaries = (value: string) => new RegExp(`(^|\\b)${value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=\\b|$)`, 'i');
const canon = (s: string) => s.trim().replace(/\s+/g,' ');
const eq = (a?: string|null,b?: string|null) => canon(a||'').localeCompare(canon(b||''), undefined, {sensitivity:'accent'})===0;

function applyRule(title: string, rules: VendorRuleInput[]): string|null {
  for (const rule of [...rules].filter(r=>r.enabled!==false).sort((a,b)=>(b.priority??100)-(a.priority??100))) {
    const value = rule.matchValue.trim();
    let matched = false;
    if (rule.matchType === 'Contains' || rule.matchType === 'Alias') matched = boundaries(value).test(title);
    if (rule.matchType === 'Starts With') matched = title.toLowerCase().startsWith(value.toLowerCase());
    if (rule.matchType === 'Exact') matched = eq(title, value);
    if (rule.matchType === 'Regex') { try { matched = new RegExp(value,'i').test(title); } catch { matched = false; } }
    if (matched) return canon(rule.vendor);
  }
  return null;
}

export function detectVendor(title: string, currentVendor = '', context: DetectionContext = {}): DetectionResult {
  const normalized = normalizeProductTitle(title);
  const current = canon(currentVendor);
  const rules = context.rules ?? [];
  const aliases = { ...DEFAULT_ALIASES, ...(context.aliases ?? {}) };
  const known = Array.from(new Set([...(context.knownVendors ?? DEFAULT_KNOWN_VENDORS), ...(context.existingVendors ?? [])])).filter(Boolean);
  const generic = (context.genericVendors ?? ['Dubailist.com','Unknown','Generic','No Vendor','N/A','']).map(v=>v.toLowerCase());
  const currentIsGeneric = !current || generic.includes(current.toLowerCase());

  const manual = applyRule(normalized, rules);
  if (manual) return finish(manual, 100, 'Manual vendor rule matched product title', 'manual_rule', current, currentIsGeneric);

  for (const [alias, vendor] of Object.entries(aliases).sort((a,b)=>b[0].length-a[0].length)) {
    if (boundaries(alias).test(normalized)) return finish(vendor, 98, `Vendor alias “${alias}” matched product title`, 'alias', current, currentIsGeneric);
  }

  const matches = known.filter(v => boundaries(v).test(normalized)).sort((a,b)=>b.length-a.length);
  if (matches.length) {
    const vendor = matches[0];
    return finish(vendor, 98, 'Known vendor matched in product title', vendor.includes(' ')?'multi_word_vendor':'known_vendor', current, currentIsGeneric);
  }

  if (!currentIsGeneric && boundaries(current).test(normalized)) {
    return { vendor: current, confidence: 95, reason: 'Existing Shopify vendor matches product title', source: 'existing_vendor', status: 'ALREADY_CORRECT' };
  }

  const firstMeaningful = normalized.split(/\s+/).find(w => w.length > 1 && !GENERIC_WORDS.has(w.toLowerCase()) && !/^\d/.test(w));
  if (firstMeaningful && !currentIsGeneric && eq(firstMeaningful,current)) {
    return { vendor: current, confidence: 90, reason: 'Existing valid vendor is supported by safe title analysis', source: 'safe_title_analysis', status: 'ALREADY_CORRECT' };
  }

  return { vendor: null, confidence: 0, reason: 'No reliable vendor match found; manual review required', source: 'manual_review', status: 'NO_VENDOR_FOUND' };
}

function finish(vendor: string, confidence: number, reason: string, source: string, current: string, currentIsGeneric: boolean): DetectionResult {
  if (!currentIsGeneric && eq(current, vendor)) return { vendor, confidence, reason, source, status: 'ALREADY_CORRECT' };
  if (!currentIsGeneric && !eq(current, vendor)) return { vendor, confidence, reason: `${reason}; conflicts with current Shopify vendor`, source, status: 'CONFLICT' };
  const status: DetectionStatus = confidence >= 90 ? 'HIGH_CONFIDENCE' : confidence >= 70 ? 'REVIEW_RECOMMENDED' : 'REVIEW_REQUIRED';
  return { vendor, confidence, reason, source, status };
}
