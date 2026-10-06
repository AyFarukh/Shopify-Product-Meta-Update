import { describe, expect, it } from 'vitest';
import { detectVendor } from '../server/vendor-detection/vendorDetectionService.js';

describe('vendor detection',()=>{
  const knownCases:[string,string][]=[
    ['Fila Disruptor II Premium Orange Shoes','Fila'],
    ['SIZE XS - Fila Women French Terry Jogger','Fila'],
    ['Dove Baby Sensitive Moisture Head to Toe Wash','Dove'],
    ['Elizabeth Arden Flawless Finish Foundation','Elizabeth Arden'],
    ['Tom Ford Cream Blush','Tom Ford'],
    ['YSL Yves Saint Laurent Slim Velvet Lipstick','Yves Saint Laurent'],
    ['Green Hill MMA Gloves Iron','Green Hill'],
    ['Shock Doctor Adult Gel Nano Mouthguard','Shock Doctor'],
    ['2 Pack Dove Soap','Dove'],
    ['10 Pcs Fila Socks','Fila'],
    ['3 Pair Green Hill Boxing Gloves','Green Hill'],
    ['1 Set Tom Ford Makeup','Tom Ford'],
    ['5 Pcs Elizabeth Arden Lipstick','Elizabeth Arden'],
  ];

  it.each(knownCases)('%s => %s',(title,vendor)=>{
    const result=detectVendor(title,'Dubailist.com');
    expect(result.vendor).toBe(vendor);
    expect(result.confidence).toBeGreaterThanOrEqual(90);
  });

  it('never uses a leading integer as vendor and creates the required fallback',()=>{
    const result=detectVendor(
      '1 Pair Stainless Steel Ear Buckle Earrings For Women Steel-Color Fadeless Hypoallergenic Hoop Earring Jewelry',
      'Unknown',
    );
    expect(result.vendor).toBe('Pair-Stainless');
    expect(result.vendor).not.toMatch(/^\d+$/);
    expect(result.source).toBe('title_fallback');
    expect(result.status).toBe('REVIEW_RECOMMENDED');
  });

  it('ignores non-pair quantity prefixes for fallback detection',()=>{
    expect(detectVendor('2 Pack Stainless Steel Hooks','Unknown').vendor).toBe('Stainless-Steel');
    expect(detectVendor('10 Pcs Cotton Sports Socks','Unknown').vendor).toBe('Cotton-Sports');
    expect(detectVendor('1 Set Ceramic Kitchen Bowls','Unknown').vendor).toBe('Ceramic-Kitchen');
  });

  it('uses one meaningful word when a second useful word is unavailable',()=>{
    const result=detectVendor('100 Premium Widget','Unknown');
    expect(result.vendor).toBe('Widget');
    expect(result.confidence).toBe(65);
    expect(result.status).toBe('REVIEW_REQUIRED');
  });

  it('returns no vendor when the title contains no meaningful candidate',()=>{
    const result=detectVendor('100 Pack Set Qty Size','Unknown');
    expect(result.vendor).toBeNull();
    expect(result.status).toBe('NO_VENDOR_FOUND');
  });

  it('marks already-correct known vendor without update',()=>{
    expect(detectVendor('Dove Baby Sensitive Moisture Wash','Dove').status).toBe('ALREADY_CORRECT');
  });

  it('marks a valid current vendor conflict when title suggests another known vendor',()=>{
    expect(detectVendor('Dove Baby Wash','Tom Ford').status).toBe('CONFLICT');
  });

  it('prefers the longest multi-word known vendor match',()=>{
    expect(detectVendor('Yves Saint Laurent Slim Lipstick','Unknown').vendor).toBe('Yves Saint Laurent');
  });

  it('known brand wins over generic and quantity words near the beginning',()=>{
    expect(detectVendor('1 Pair Green Hill Boxing Gloves','Unknown').vendor).toBe('Green Hill');
    expect(detectVendor('2 Pack Dove Soap','Unknown').vendor).toBe('Dove');
  });
});
