/**
 * A job can outlive this page's own Cloudflare Access session. When that session ends, the
 * next same-origin XHR is answered with a 302 to the Access login page, the browser follows
 * it cross-origin, and the request dies as a bare "Network Error" -- which says nothing
 * about logging in again. Name it, since the fix is one reload.
 *
 * Its own module so that both pipeline tabs can use it without a component file exporting
 * a plain function, which would cost React Fast Refresh for that file.
 */
const describeFailure = (error, site) => {
  const sessionLikelyExpired = !error.response
    && (error.code === 'ERR_NETWORK' || /network error/i.test(error.message ?? ''));
  if (sessionLikelyExpired) {
    return `${site.label} 連線被擋下。最常見的原因是這個頁面的 Cloudflare Access 登入過期了，`
      + '請重新整理頁面後再試（工作本身可能已經在伺服器跑完，重試沒有副作用）。';
  }
  return error.response?.data?.detail ?? error.message;
};

export default describeFailure;
