export function solve({total,weights}){return weights.map(w=>Math.round(total*w/weights.reduce((a,b)=>a+b,0)))}
