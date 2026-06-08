
export default async function handler(req) {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return new Response('Missing URL parameter', { status: 400 });
  }

  // 鉴权逻辑：比对硬编码的 Token（因为此代码部署在 private 仓库）
  const expectedToken = 'bili_token_vercel'; // 请修改为你自己的密码
  if (expectedToken) {
    const providedToken = req.headers.get('x-proxy-token');
    if (providedToken !== expectedToken) {
      return new Response('Unauthorized: Invalid proxy token', { status: 401 });
    }
  }

  try {
    const target = new URL(targetUrl);
    // 仅允许转发 bilibili 相关请求
    if (!target.hostname.includes('bilibili.com') && !target.hostname.includes('biliapi.net') && !target.hostname.includes('b23.tv')) {
      return new Response('Forbidden', { status: 403 });
    }

    const headers = new Headers();
    if (req.headers.has('User-Agent')) headers.set('User-Agent', req.headers.get('User-Agent'));
    if (req.headers.has('Referer')) headers.set('Referer', req.headers.get('Referer'));
    if (req.headers.has('Cookie')) headers.set('Cookie', req.headers.get('Cookie'));
    if (req.headers.has('Origin')) headers.set('Origin', req.headers.get('Origin'));

    const init = {
      method: req.method,
      headers: headers,
      redirect: 'manual'
    };
    
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      init.body = req.body;
    }

    const response = await fetch(targetUrl, init);
    
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
