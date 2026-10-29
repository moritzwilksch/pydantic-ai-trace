// Base UI's types tell event handlers apart from other function props, such as
// `ref`, by whether their argument extends React.SyntheticEvent. preact/compat, which
// tsconfig.json maps "react" to, declares no SyntheticEvent, so the check would match
// every function prop and mistype each `ref` the coss components forward. This
// declares the React shape; Preact's own events do not match it, so their handlers
// keep their Preact types.
import "preact/compat";

declare module "preact/compat" {
  interface SyntheticEvent<T = Element, E = Event> {
    nativeEvent: E;
    currentTarget: T;
    isDefaultPrevented(): boolean;
    isPropagationStopped(): boolean;
    persist(): void;
  }
}
