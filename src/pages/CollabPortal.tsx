import { useParams } from 'react-router-dom'
import CollabHostView from './collab/CollabHostView'
import CollabGuestView from './collab/CollabGuestView'

// Thin router: no `roomId` in the URL → host a fresh room, otherwise join.
export default function CollabPortal() {
  const { roomId } = useParams<{ roomId: string }>()
  if (!roomId) return <CollabHostView />
  return <CollabGuestView roomId={roomId} />
}
