<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import donateQr from "$lib/assets/donate-qr.png";

  let {
    onclose,
    noticeUrl = "https://h2omol.com/univ-agent-project-notice",
    blogUrl = "https://h2omol.com",
    contactEmail = "jh.chung811@gmail.com",
  }: {
    onclose: () => void;
    noticeUrl?: string;
    blogUrl?: string;
    contactEmail?: string;
  } = $props();

  const CHROME_EXTENSION_URL =
    "https://chromewebstore.google.com/detail/hfemchmkjbcnikdmfbipnclbkgomhhkj";

  type Tab = "notice" | "about" | "donate";

  let tab = $state<Tab>("notice");
  let qrFailed = $state(false);
  let linkError = $state("");

  onMount(() => {
    window.addEventListener("keydown", onKeydown);
  });

  onDestroy(() => {
    window.removeEventListener("keydown", onKeydown);
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onclose();
  }

  /** 앱 내부 창이 아닌 PC 기본 브라우저/메일 앱으로 연다. */
  async function openExternal(url: string) {
    linkError = "";
    try {
      await openUrl(url);
    } catch (error) {
      linkError = `링크를 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "notice", label: "실시간 공지" },
    { id: "about", label: "프로젝트 소개 & 문의" },
    { id: "donate", label: "개발자 커피 한 잔 💖" },
  ];
</script>

<div class="backdrop" role="presentation" onmousedown={(event) => { if (event.target === event.currentTarget) onclose(); }}>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="notice-modal-title">
    <header>
      <h2 id="notice-modal-title">공지 / 후원 / 문의</h2>
      <button type="button" class="close" aria-label="닫기" onclick={onclose}>×</button>
    </header>

    <div class="tabs" role="tablist">
      {#each tabs as item (item.id)}
        <button
          type="button"
          role="tab"
          class:coffee-tab={item.id === "donate"}
          aria-selected={tab === item.id}
          onclick={() => { tab = item.id; }}
        >{item.label}</button>
      {/each}
    </div>

    <div class="body">
      {#if tab === "notice"}
        <p class="muted">긴급 점검이나 패치 소식은 공지 페이지에서 확인할 수 있습니다. 버튼을 누르면 기본 웹 브라우저에서 열립니다.</p>
        <div class="link-row">
          <button type="button" data-testid="link-notice" onclick={() => openExternal(noticeUrl)}>공지 페이지 열기 (h2omol.com)</button>
        </div>
        {#if linkError}<p class="error" role="alert">{linkError}</p>{/if}
      {:else if tab === "about"}
        <h3>대학생을 위한 로컬 &amp; 캠퍼스 AI 강의 분석기 (Univ-Agent)</h3>
        <p class="muted">강의 영상과 교안으로 요약, 시험 대비 문제, 치트시트를 만들어 드립니다.</p>
        <section class="faq-card" data-testid="faq-card" aria-labelledby="faq-question">
          <h4 id="faq-question">💡 LMS 강의영상 다운로드는 어디서 하나요?</h4>
          <p>학교 LMS(블랙보드 등)에서 강의 영상을 손쉽게 내려받아 본 앱에 바로 넣을 수 있는 전용 확장프로그램입니다. 함께 사용하시면 학습 효율이 배가됩니다.</p>
          <button type="button" class="highlight" data-testid="link-extension" onclick={() => openExternal(CHROME_EXTENSION_URL)}>Chrome 웹스토어에서 다운로더 설치하기</button>
        </section>
        <div class="link-row">
          <button type="button" data-testid="link-blog" onclick={() => openExternal(blogUrl)}>개발자 블로그 (h2omol.com)</button>
          <button type="button" data-testid="link-contact" onclick={() => openExternal(`mailto:${contactEmail}?subject=${encodeURIComponent("[Univ-Agent] 버그 제보 / 문의")}`)}>버그 제보 / 문의 메일</button>
        </div>
        {#if linkError}<p class="error" role="alert">{linkError}</p>{/if}
      {:else}
        <p class="lead">이 프로그램이 학업에 도움이 되셨다면, 커피 한 잔으로 서버비와 개발을 응원해 주세요!</p>
        <p class="coffee-badge" data-testid="coffee-badge">커피 한 잔 선물하기 💖</p>
        <div class="qr-card fade-in" data-testid="qr-card">
          <p class="qr-top">스마트폰 카메라나 카카오톡으로 스캔해 주세요</p>
          {#if qrFailed}
            <div class="qr-fallback" role="status">QR 이미지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>
          {:else}
            <img class="qr-image" src={donateQr} alt="카카오페이 송금 QR 코드" onerror={() => { qrFailed = true; }} />
          {/if}
          <p class="qr-bottom">보내주신 응원은 서버 운영비(GPU)와 기능 개발에 전액 사용됩니다. 감사합니다!</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 1200; display: grid; place-items: center; background: rgba(23, 33, 58, 0.45); }
  .modal { width: min(640px, calc(100vw - 32px)); max-height: calc(100vh - 48px); display: flex; flex-direction: column; border-radius: 16px; background: white; box-shadow: 0 20px 60px rgba(23, 33, 58, 0.3); overflow: hidden; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #edf0f6; }
  h2 { margin: 0; font-size: 1.1rem; }
  h3 { margin: 0 0 8px; font-size: 1.05rem; }
  button { padding: 9px 14px; border: 1px solid #cbd2e5; border-radius: 9px; background: white; color: #26396d; font: inherit; font-size: 0.88rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #eef1ff; border-color: #4758c4; }
  .close { padding: 2px 10px; font-size: 1.3rem; line-height: 1.2; border: none; }
  .tabs { display: flex; gap: 6px; padding: 12px 20px 0; flex-wrap: wrap; }
  .tabs button[aria-selected="true"], .tabs button[aria-selected="true"]:hover { background: #4255bf; border-color: #4255bf; color: #ffffff; }
  .body { padding: 20px; overflow: auto; min-height: 320px; }
  .muted { color: #59647a; font-size: 0.9rem; }
  .link-row { display: grid; gap: 10px; margin-top: 16px; }
  .link-row button { text-align: left; }
  .faq-card { padding: 16px; border: 1px solid #b9c5f5; border-radius: 12px; background: #f3f5ff; }
  .faq-card h4 { margin: 0 0 8px; font-size: 1rem; color: #26396d; }
  .faq-card p { margin: 0 0 12px; font-size: 0.88rem; line-height: 1.6; color: #3b475e; }
  .faq-card .highlight, .faq-card .highlight:hover { background: #4255bf; border-color: #4255bf; color: #ffffff; }
  .faq-card .highlight:hover { background: #3345a8; border-color: #3345a8; }
  .coffee-badge { width: fit-content; margin: 0 auto 14px; padding: 8px 18px; border-radius: 999px; background: #ec4899; color: #ffffff; font-size: 0.92rem; font-weight: 700; transition: background 0.2s, transform 0.2s; }
  .coffee-badge:hover { background: #db2777; color: #ffffff; transform: translateY(-1px); }
  .tabs button.coffee-tab, .tabs button.coffee-tab:hover { border-color: #ec4899; color: #be185d; }
  .tabs button.coffee-tab:hover { background: #fdf2f8; }
  .tabs button.coffee-tab[aria-selected="true"], .tabs button.coffee-tab[aria-selected="true"]:hover { background: #ec4899; border-color: #ec4899; color: #ffffff; }
  .error { color: #a12525; font-size: 0.85rem; }
  .lead { margin: 0 0 16px; text-align: center; color: #3b475e; }
  .qr-card { width: 240px; margin: 0 auto; padding: 16px; border: 1px solid #dfe4ef; border-radius: 16px; background: #fff; text-align: center; box-shadow: 0 6px 20px rgba(23, 33, 58, 0.08); }
  .qr-top { margin: 0 0 10px; font-size: 0.85rem; font-weight: 600; color: #26396d; }
  .qr-bottom { margin: 10px 0 0; font-size: 0.78rem; color: #59647a; line-height: 1.5; }
  .qr-image { display: block; width: 208px; max-height: 240px; object-fit: contain; margin: 0 auto; border-radius: 10px; }
  .qr-fallback { display: grid; place-items: center; width: 208px; height: 200px; margin: 0 auto; border: 1px dashed #cbd2e5; border-radius: 10px; color: #59647a; font-size: 0.82rem; padding: 8px; box-sizing: border-box; }
  .fade-in { animation: fade-in 0.4s ease-out; }
  @keyframes fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
</style>
