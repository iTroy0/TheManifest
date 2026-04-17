// Always-loaded stub that lazy-imports the call-lane runtime. Keeps
// useCall / useLocalMedia / CallPanel / VideoTile / AudioTile /
// useSpeakingLevels out of the initial bundle; they download as a
// separate chunk once the main page has rendered. If the user never
// participates in a call, the chunk still arrives but doesn't block
// first paint.
//
// Design note: we can't truly defer "until first call-join" because
// the host needs useCall's signaling handler installed BEFORE the
// first guest's call-join arrives — otherwise the message is dropped.
// React.lazy gets us the bundle split without that coordination cost.

import { Suspense, lazy } from 'react'
import type { CallPanelRuntimeProps } from './CallPanelRuntime'

const CallPanelRuntime = lazy(() => import('./CallPanelRuntime'))

export default function CallPanelLazy(props: CallPanelRuntimeProps) {
  // Empty fallback — the rest of the page renders without the call
  // panel, then the panel slides in once the chunk loads. Any flash is
  // minimal because the chunk fires the moment this component mounts.
  return (
    <Suspense fallback={null}>
      <CallPanelRuntime {...props} />
    </Suspense>
  )
}
