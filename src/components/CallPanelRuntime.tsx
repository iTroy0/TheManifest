// Lazy-loaded wrapper for the call lane. Defers loading of useCall,
// useLocalMedia, and CallPanel (plus their transitive imports — VideoTile,
// AudioTile, useSpeakingLevels) until the page's main layout has rendered.
//
// Pages never reach into the `call` return value; they only pass it to
// CallPanel. So the hook calls move inside this component and the page
// only hands over the upstream options + presentation props. React.lazy
// splits this file into its own chunk automatically.

import { useCall, type UseCallOptions } from '../hooks/useCall'
import { useLocalMedia } from '../hooks/useLocalMedia'
import CallPanel from './CallPanel'

export interface CallPanelRuntimeProps {
  // Every UseCallOptions field except `localMedia` — that's constructed
  // inside this component by useLocalMedia so the page doesn't need to
  // import the hook at all.
  callOptions: Omit<UseCallOptions, 'localMedia'>
  myName: string
  disabled: boolean
  connectionStatus: string
}

export default function CallPanelRuntime({
  callOptions,
  myName,
  disabled,
  connectionStatus,
}: CallPanelRuntimeProps) {
  const localMedia = useLocalMedia()
  const call = useCall({ ...callOptions, localMedia })
  return (
    <CallPanel
      call={call}
      myName={myName}
      disabled={disabled}
      connectionStatus={connectionStatus}
    />
  )
}
