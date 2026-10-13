<script lang="ts">
  import type { MediaFile } from "$lib/media-files";

  let {
    items,
    heading,
    hint,
    addLabel,
    emptyText,
    badgeLabel = "",
    badgeTooltip = "",
    disabled = false,
    onadd,
    onremove,
    onmove,
    onreorder,
  }: {
    items: MediaFile[];
    heading: string;
    hint: string;
    addLabel: string;
    emptyText: string;
    badgeLabel?: string;
    badgeTooltip?: string;
    disabled?: boolean;
    onadd: () => void;
    onremove: (index: number) => void;
    onmove: (index: number, delta: number) => void;
    onreorder: (fromIndex: number, toIndex: number) => void;
  } = $props();

  let draggedIndex = $state<number | null>(null);
  let dragOverIndex = $state<number | null>(null);
  let showBadgeTip = $state(false);

  function handleDragStart(event: DragEvent, index: number) {
    if (disabled) {
      event.preventDefault();
      return;
    }
    draggedIndex = index;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
    }
  }

  function handleDragOver(event: DragEvent, index: number) {
    if (disabled) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (draggedIndex !== null && draggedIndex !== index) dragOverIndex = index;
  }

  function handleDrop(event: DragEvent, index: number) {
    event.preventDefault();
    const fromIndex = draggedIndex;
    draggedIndex = null;
    dragOverIndex = null;
    if (disabled || fromIndex === null || fromIndex === index) return;
    onreorder(fromIndex, index);
  }

  function handleDragEnd() {
    draggedIndex = null;
    dragOverIndex = null;
  }
</script>

<section class="media-section">
  <div class="media-heading">
    <div>
      <h3>
        {heading}
        {#if badgeLabel}
          <button
            type="button"
            class="info-badge"
            class:active={showBadgeTip}
            title={badgeTooltip}
            aria-expanded={showBadgeTip}
            aria-label={badgeTooltip}
            onclick={() => { showBadgeTip = !showBadgeTip; }}
          >{badgeLabel}</button>
        {/if}
      </h3>
      {#if showBadgeTip}
        <p class="info-tip" role="status">{badgeTooltip}</p>
      {/if}
      <p class="hint">{hint}</p>
    </div>
    <button type="button" onclick={onadd} disabled={disabled}>{addLabel}</button>
  </div>

  {#if items.length > 0}
    <ol class="media-list">
      {#each items as item, index (item.path + index)}
        <li
          draggable={!disabled}
          class:dragging={draggedIndex === index}
          class:drag-over={dragOverIndex === index && draggedIndex !== index}
          ondragstart={(event) => handleDragStart(event, index)}
          ondragover={(event) => handleDragOver(event, index)}
          ondrop={(event) => handleDrop(event, index)}
          ondragend={handleDragEnd}
        >
          <span class="index">{index + 1}</span>
          <span class="name">{item.name}</span>
          <button
            type="button"
            aria-label={`${item.name} 위로 이동`}
            onclick={() => onmove(index, -1)}
            disabled={disabled || index === 0}
          >▲</button>
          <button
            type="button"
            aria-label={`${item.name} 아래로 이동`}
            onclick={() => onmove(index, 1)}
            disabled={disabled || index === items.length - 1}
          >▼</button>
          <button
            type="button"
            class="remove"
            aria-label={`${item.name} 제거`}
            onclick={() => onremove(index)}
            disabled={disabled}
          >×</button>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="empty">{emptyText}</p>
  {/if}
</section>

<style>
  .media-section { padding: 20px 0; border-bottom: 1px solid #edf0f6; }
  .media-section:last-of-type { border-bottom: none; }
  .media-heading { display: flex; gap: 16px; align-items: flex-start; justify-content: space-between; }
  .media-heading h3 { margin: 0; font-size: 1rem; }
  .info-badge {
    margin-left: 6px;
    padding: 2px 8px;
    border: 1px solid #c2cef5;
    border-radius: 999px;
    background: #eef2ff;
    color: #304ba6;
    font: inherit;
    font-size: 0.7rem;
    font-weight: 700;
    cursor: pointer;
  }
  .info-badge:hover, .info-badge.active { background: #dbe2ff; border-color: #8597f1; }
  .info-badge:focus-visible { outline: 3px solid #8597f1; outline-offset: 2px; }
  .info-tip {
    margin: 8px 0 0;
    padding: 8px 12px;
    border-radius: 8px;
    background: #eef2ff;
    color: #304ba6;
    font-size: 0.8rem;
  }
  .hint { margin: 6px 0 0; color: #59647a; font-size: 0.85rem; }
  .media-heading button {
    flex-shrink: 0;
    padding: 10px 18px;
    border: 1px solid #cbd2e5;
    border-radius: 9px;
    background: white;
    color: #26396d;
    font: inherit;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }
  .media-heading button:hover:not(:disabled) { background: #eef1ff; border-color: #4758c4; }
  .media-heading button:focus-visible { outline: 3px solid #8597f1; outline-offset: 3px; }
  .media-heading button:disabled { opacity: 0.5; cursor: not-allowed; }
  .media-list { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 8px; }
  .media-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid #dfe4ef;
    border-radius: 10px;
    background: #fafbfe;
    cursor: grab;
  }
  .media-list li.dragging { opacity: 0.5; }
  .media-list li.drag-over {
    border-color: #4255bf;
    background: #eef1ff;
    box-shadow: inset 3px 0 0 #4255bf;
  }
  .media-list .index { flex: 0 0 auto; color: #344694; font-weight: 700; }
  .media-list .name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .media-list button {
    flex-shrink: 0;
    padding: 6px 9px;
    border: 1px solid #cbd2e5;
    border-radius: 8px;
    background: white;
    color: #26396d;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
  }
  .media-list button:hover:not(:disabled) { background: #eef1ff; border-color: #4758c4; }
  .media-list button:focus-visible { outline: 3px solid #8597f1; outline-offset: 3px; }
  .media-list button:disabled { opacity: 0.5; cursor: not-allowed; }
  .empty { margin: 16px 0 0; color: #59647a; }
</style>
