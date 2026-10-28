// Brus för terrängen (docs/terrain.md). Ren JavaScript, som field.js och shapes.js.

// Låg-frekventa kullar: några sinusvågor i olika riktningar (vattenscenernas mark)
export const hills = (x, z) => Math.sin(x * 0.11 + 1.3) * Math.cos(z * 0.09 - 0.4) * 0.5 + Math.sin(x * 0.043 - z * 0.051) * 0.7 + Math.sin(x * 0.27 + z * 0.19) * 0.12;
