import type { Plugin } from "@opencode/plugin/tui";
import type { InputRenderable, RGBA, ScrollBoxRenderable } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import fuzzysort from "fuzzysort";
import type { ActivityItem } from "./activity-model";
import { themeColor, themeMuted } from "./activity-theme";

type Choice = Pick<ActivityItem, "id" | "title" | "subtitle" | "pinned"> & {
  category: string;
  closed: boolean;
};

export function ActivityPicker(props: {
  ctx: Plugin.Context;
  fallbackColor: RGBA;
  items: () => Choice[];
  current: string | undefined;
  pin: (id: string) => Promise<void>;
  open: (id: string) => Promise<void>;
}) {
  const { ctx } = props;
  const [query, setQuery] = createSignal("");
  const [selectedID, setSelectedID] = createSignal(props.current);
  const [pinning, setPinning] = createSignal(false);
  const [height, setHeight] = createSignal(ctx.renderer.height);
  let input: InputRenderable | undefined;
  let scroll: ScrollBoxRenderable | undefined;
  let closed = false;
  const foreground = () => themeColor(ctx.theme.text, props.fallbackColor);
  const muted = () => themeMuted(ctx.theme.text, foreground());
  const grouped = createMemo(() => {
    const items = query()
      ? fuzzysort.go(query(), props.items(), {
          keys: ["title", "category"],
          scoreFn: (result) => result[0].score * 2 + result[1].score,
        }).map((result) => result.obj)
      : props.items();
    const groups = new Map<string, Choice[]>();
    for (const item of items) {
      const group = groups.get(item.category) ?? [];
      group.push(item);
      groups.set(item.category, group);
    }
    return [...groups];
  });
  const choices = createMemo(() => grouped().flatMap(([, items]) => items));
  const selected = () =>
    choices().find((item) => item.id === selectedID()) ?? choices()[0];
  const select = (index: number) => setSelectedID(choices()[index]?.id);
  const move = (direction: number) => {
    const items = choices();
    if (!items.length) return;
    const index = items.findIndex((item) => item.id === selected()?.id);
    select((index + direction % items.length + items.length) % items.length);
  };
  const open = (id = selected()?.id) => {
    if (!id) return;
    ctx.ui.dialog.clear();
    void props.open(id);
  };
  const togglePin = async () => {
    const item = selected();
    if (!item || pinning()) return;
    setSelectedID(item.id);
    setPinning(true);
    try {
      await props.pin(item.id);
    } finally {
      if (!closed) setPinning(false);
    }
  };
  ctx.keymap.layer(() => ({
    mode: "global",
    target: () => input,
    priority: 100,
    commands: [
      { bind: "up", run: () => move(-1) },
      { bind: "ctrl+p", run: () => move(-1) },
      { bind: "down", run: () => move(1) },
      { bind: "ctrl+n", run: () => move(1) },
      { bind: "pageup", run: () => move(-10) },
      { bind: "pagedown", run: () => move(10) },
      { bind: "home", run: () => { select(0); } },
      { bind: "end", run: () => { select(choices().length - 1); } },
      { bind: "return", run: () => open() },
      { bind: "escape", run: () => ctx.ui.dialog.clear() },
      {
        id: "threads.activity.choose.pin",
        title: "Pin/unpin highlighted Activity conversation",
        bind: "ctrl+f",
        run: togglePin,
      },
    ],
  }));
  let scrollTo: string | undefined;
  createEffect(() => {
    grouped();
    scrollTo = selected()?.id;
  });
  const reveal = () => {
    if (!scrollTo || !scroll) return;
    scroll.scrollChildIntoView(`activity-picker-row-${scrollTo}`);
    scrollTo = undefined;
  };
  const resize = () => setHeight(ctx.renderer.height);
  ctx.renderer.addPostProcessFn(reveal);
  ctx.renderer.on("resize", resize);
  onCleanup(() => {
    closed = true;
    ctx.renderer.removePostProcessFn(reveal);
    ctx.renderer.off("resize", resize);
  });
  return (
    <box id="activity-picker" paddingX={2} paddingY={1} gap={1}>
      <text fg={foreground()}><b>Activity</b></text>
      <input
        id="activity-picker-search"
        ref={(node) => { input = node; }}
        focused
        placeholder="Search"
        textColor={foreground()}
        focusedTextColor={foreground()}
        onInput={(value) => {
          setQuery(value);
          setSelectedID(undefined);
        }}
      />
      <scrollbox
        ref={(node) => { scroll = node; }}
        height={Math.max(1, Math.min(
          choices().length + grouped().length * 2,
          Math.floor(height() / 2) - 6,
        ))}
        scrollX={false}
        scrollbarOptions={{ visible: false }}
      >
        <For each={grouped()}>{([category, items]) => <>
          <text fg={muted()} marginTop={1}>{category}</text>
          <For each={items}>{(item) => (
            <box
              id={`activity-picker-row-${item.id}`}
              height={1}
              flexShrink={0}
              flexDirection="row"
              backgroundColor={selected()?.id === item.id
                ? ctx.theme.background.raised?.high ?? themeColor(ctx.theme.background, props.fallbackColor)
                : undefined}
              onMouseUp={(event) => {
                event.stopPropagation();
                if (event.button === 0) open(item.id);
              }}
            >
              <text
                id={`activity-picker-title-${item.id}`}
                fg={foreground()}
                width="60%"
                wrapMode="none"
                truncate
              >{`${selected()?.id === item.id ? ">" : " "} ${item.pinned ? "◆" : "◇"} ${item.title}`}</text>
              <text fg={muted()} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate>
                {`${item.subtitle}${item.closed ? " · Closed" : ""}`}
              </text>
            </box>
          )}</For>
        </>}</For>
        <Show when={!choices().length}>
          <text fg={muted()}>No matching conversations</text>
        </Show>
      </scrollbox>
      <text id="activity-picker-hint" fg={muted()}>
        {`${ctx.keymap.shortcuts("threads.activity.choose.pin").join(" / ")} ${selected()?.pinned ? "Unpin" : "Pin"} · enter Open · esc Close`}
      </text>
    </box>
  );
}
