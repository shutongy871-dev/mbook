import { expect, it, vi } from 'vitest';
import { weapi } from '@/core/sources/netease-crypto';

it('encrypts two AES-CBC layers without double PKCS#7 padding', async () => {
  const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
    (array as Uint8Array).fill(0); return array;
  });
  try {
    const input = { ids: [123], csrf_token: '', message: '中文测试' };
    const form = await weapi(input);
    const decrypt = async (base64: string, secret: string) => {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'AES-CBC', false, ['decrypt']);
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      return new TextDecoder().decode(await crypto.subtle.decrypt({
        name: 'AES-CBC', iv: new TextEncoder().encode('0102030405060708'),
      }, key, bytes));
    };
    const first = await decrypt(form.params, 'a'.repeat(16));
    expect(await decrypt(first, '0CoJUm6Qyw8W8jud')).toBe(JSON.stringify(input));
    expect(form.encSecKey).toMatch(/^[0-9a-f]{256}$/);
  } finally { random.mockRestore(); }
});
