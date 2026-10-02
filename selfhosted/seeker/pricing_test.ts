import assert from 'node:assert/strict';
import {parsePrice,quotedAmount} from './pricing.ts';
Deno.test('quotes collect at least USD price, including sub-cent SKR rounding',()=>{
 assert.equal(quotedAmount(2,'17804'),'1123344');
 assert.equal(quotedAmount(100,'1000000'),'1000000');
 assert.equal(quotedAmount(0.5,'1000000'),'5000');
 assert.equal(quotedAmount(0.029,'1000000'),'290');
 const rate=parsePrice({mint:{usdPrice:0.017804633}},'mint',1_000_000);
 assert.equal(rate.usd_micros_per_skr,'17804');
});
Deno.test('rates refuse missing, negative, zero and nonfinite prices',()=>{
 for(const usdPrice of [null,0,-1,Infinity,NaN,'0.01']) assert.throws(()=>parsePrice({mint:{usdPrice}},'mint'));
 assert.throws(()=>parsePrice({},'mint'));
});
