import type { Plugin } from "@opencode/plugin/tui";
import type { RGBA } from "@opentui/core";
import type { SpinnerRenderable } from "opentui-spinner";
import { Show } from "solid-js";
import { footerText, type FooterSummary } from "./activity-model";
import { themeColor, themeMuted } from "./activity-theme";

// OpenCode registers its spinner renderable under this name; the type comes from the same package.
declare module "@opentui/solid" {
  interface OpenTUIComponents {
    spinner: typeof SpinnerRenderable;
  }
}

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Like OpenCode's /btw indicator: nothing while idle, a spinner and counts while work runs.
export function ThreadsIndicator(props: {
  ctx: Plugin.Context;
  id: string;
  fallbackColor: RGBA;
  spinner: boolean;
  summary: () => FooterSummary;
  shortcut: () => string | undefined;
  open: () => void;
}) {
  const text = () => footerText(props.summary());
  const foreground = () => themeColor(props.ctx.theme.text, props.fallbackColor);
  const info = () => themeColor(props.ctx.theme.text.feedback.info, foreground());
  const warning = () =>
    themeColor(props.ctx.theme.text.feedback.warning, foreground());
  return (
    <Show when={text().visible}>
      <box
        id={props.id}
        flexDirection="row"
        flexShrink={0}
        gap={1}
        onMouseUp={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          props.open();
        }}
      >
        <Show when={text().spinning}>
          <Show
            when={props.spinner}
            fallback={<text fg={info()}>⋯</text>}
          >
            <box id={`${props.id}-spinner`} flexShrink={0}>
              <spinner
                frames={frames}
                interval={80}
                color={info()}
              />
            </box>
          </Show>
        </Show>
        <Show when={text().label}>
          <text id={`${props.id}-label`} fg={info()} wrapMode="none">
            {text().label}
          </text>
        </Show>
        <Show when={text().attention}>
          <text id={`${props.id}-attention`} fg={warning()} wrapMode="none">
            {text().attention}
          </text>
        </Show>
        <Show when={props.shortcut()}>
          <text fg={themeMuted(props.ctx.theme.text, foreground())} wrapMode="none">
            {props.shortcut()}
          </text>
        </Show>
      </box>
    </Show>
  );
}
