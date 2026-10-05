import { describe, expect, it } from 'vitest';
import { detectVendor } from '../server/vendor-detection/vendorDetectionService.js';

describe('vendor detection',()=>{
  const cases:[string,string][]=[
    ['Fila Disruptor II Premium Orange Shoes','Fila'],
    ['SIZE XS - Fila Women French Terry Jogger','Fila'],
    ['Dove Baby Sensitive Moisture Head to Toe Wash','Dove'],
    ['Elizabeth Arden Flawless Finish Foundation','Elizabeth Arden'],
    ['Tom Ford Cream Blush','Tom Ford'],
    ['YSL Yves Saint Laurent Slim Velvet Lipstick','Yves Saint Laurent'],
    ['Green Hill MMA Gloves Iron','Green Hill'],
    ['Shock Doctor Adult Gel Nano Mouthguard','Shock Doctor'],
  ];
  it.each(cases)('%s => %s',(title,vendor)=>{const r=detectVendor(title,'Dubailist.com');expect(r.vendor).toBe(vendor);expect(r.confidence).toBeGreaterThanOrEqual(90)});
  it('does not invent unknown vendors',()=>{const r=detectVendor('Premium Professional Universal Widget 3000','Unknown');expect(r.vendor).toBeNull();expect(['NO_VENDOR_FOUND','REVIEW_REQUIRED']).toContain(r.status)});
  it('marks already-correct vendor without update',()=>{expect(detectVendor('Dove Baby Sensitive Moisture Wash','Dove').status).toBe('ALREADY_CORRECT')});
  it('requires review on conflict',()=>{expect(detectVendor('Dove Baby Wash','Tom Ford').status).toBe('CONFLICT')});
  it('prefers the longest multi-word known vendor match',()=>{expect(detectVendor('Yves Saint Laurent Slim Lipstick','Unknown').vendor).toBe('Yves Saint Laurent')});
});
