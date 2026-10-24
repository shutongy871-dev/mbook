// 网易云 weapi 请求加密（纯 Web Crypto 实现，SW 可用）
// 算法为公开的逆向事实：payload JSON 经两次 AES-CBC（固定 key + 随机 secKey），
// secKey 经公钥模幂加密为 encSecKey，POST 表单 params/encSecKey。

const PRESET_KEY = new TextEncoder().encode('0CoJUm6Qyw8W8jud');
const IV = new TextEncoder().encode('0102030405060708');
const RSA_MODULUS_HEX =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const RSA_EXPONENT = 0x10001n;
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomSecKey(): string {
  let s = '';
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 16; i++) s += BASE62.charAt((buf[i] ?? 0) % 62);
  return s;
}

async function aesCbcEncrypt(data: string, key: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as BufferSource,
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );
  // Web Crypto AES-CBC already applies PKCS#7. Manual padding corrupts weapi JSON.
  const bytes = new TextEncoder().encode(data);
  const enc = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: IV as unknown as BufferSource },
    cryptoKey,
    bytes as unknown as BufferSource,
  );
  return uint8ToBase64(new Uint8Array(enc));
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// 教科书 RSA：m = BigInt(hex(反转后的 secKey))，c = m^e mod n，输出 256 位 hex
function rsaEncrypt(secKey: string): string {
  const reversed = secKey.split('').reverse().join('');
  let hex = '';
  for (const ch of reversed) hex += ch.charCodeAt(0).toString(16).padStart(2, '0');
  const m = BigInt('0x' + hex);
  const n = BigInt('0x' + RSA_MODULUS_HEX);
  let c = 1n;
  let base = m % n;
  let exp = RSA_EXPONENT;
  while (exp > 0n) {
    if (exp & 1n) c = (c * base) % n;
    base = (base * base) % n;
    exp >>= 1n;
  }
  return c.toString(16).padStart(256, '0');
}

export interface WeapiForm {
  params: string;
  encSecKey: string;
}

export async function weapi(payload: Record<string, unknown>): Promise<WeapiForm> {
  const text = JSON.stringify(payload);
  const secKey = randomSecKey();
  const first = await aesCbcEncrypt(text, PRESET_KEY);
  const second = await aesCbcEncrypt(first, new TextEncoder().encode(secKey));
  return { params: second, encSecKey: rsaEncrypt(secKey) };
}
