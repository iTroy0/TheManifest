import { useEffect, useRef } from 'react'

export function usePageTitle(status, overallProgress) {
  const notifiedRef = useRef(false)

  useEffect(() => {
    let title = 'The Manifest'

    switch (status) {
      case 'waiting':
        title = 'Waiting for recipient... — The Manifest'
        break
      case 'connected':
      case 'manifest-received':
        title = 'Connected — The Manifest'
        break
      case 'transferring':
        title = `${overallProgress}% Sending... — The Manifest`
        break
      case 'receiving':
        title = `${overallProgress}% Receiving... — The Manifest`
        break
      case 'done':
        title = 'Transfer Complete — The Manifest'
        break
      case 'closed':
        title = 'Portal Closed — The Manifest'
        break
      case 'error':
        title = 'Error — The Manifest'
        break
    }

    document.title = title

    // Notify on completion (only once, only if tab is not focused)
    if (status === 'done' && !notifiedRef.current) {
      notifiedRef.current = true
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('The Manifest', { body: 'File transfer complete!' })
      }
    }

    if (status === 'waiting' || status === 'connecting' || status === 'initializing') {
      notifiedRef.current = false
    }
  }, [status, overallProgress])
}
