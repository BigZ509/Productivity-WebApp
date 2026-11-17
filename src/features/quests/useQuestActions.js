import { useCallback, useState } from 'react'
import { usePlayerData, useProfile, useRewards } from '../../app/providers/contexts'
import { abandonQuest, acceptQuest, completeQuest } from '../../services/quests'
import { describeGain } from '../../lib/progression'

// Quest mutations with consistent feedback. All authority is server-side:
// the UI applies the XP total the RPC returns and then re-reads persisted data.
export function useQuestActions() {
  const { profile, applyServerXp, refresh } = useProfile()
  const { activeQuests, xpEvents } = usePlayerData()
  const { showReward, toast } = useRewards()
  const [pending, setPending] = useState({})

  const track = useCallback(async (key, fn) => {
    setPending((p) => ({ ...p, [key]: true }))
    try {
      return await fn()
    } finally {
      setPending((p) => {
        const next = { ...p }
        delete next[key]
        return next
      })
    }
  }, [])

  const accept = useCallback(
    (quest) =>
      track(`accept:${quest.id}`, async () => {
        try {
          const res = await acceptQuest(quest.id)
          toast(res.alreadyActive ? `“${quest.title}” is already active.` : `Accepted “${quest.title}”.`, 'success')
          await activeQuests.reload()
          return res
        } catch (error) {
          toast(error.message, 'error', { duration: 6000 })
          return null
        }
      }),
    [track, toast, activeQuests],
  )

  const complete = useCallback(
    (instance, { note, focusSessionId } = {}) =>
      track(`complete:${instance.id}`, async () => {
        const before = profile.xp
        try {
          const res = await completeQuest(instance.id, { note, focusSessionId })
          applyServerXp(res.xpTotal)
          if (res.newlyCompleted) {
            showReward({
              xp: res.xpAwarded,
              title: instance.quest?.title || 'Quest complete',
              subtitle: 'Quest complete',
              gain: describeGain(before, res.xpTotal, profile.path),
            })
          } else {
            toast('That quest was already completed. No extra XP was awarded.', 'info')
          }
          await Promise.all([activeQuests.reload(), xpEvents.reload()])
          refresh()
          return res
        } catch (error) {
          toast(error.message, 'error', { duration: 6000 })
          await activeQuests.reload()
          return null
        }
      }),
    [track, profile.xp, profile.path, applyServerXp, showReward, toast, activeQuests, xpEvents, refresh],
  )

  const abandon = useCallback(
    (instance) =>
      track(`abandon:${instance.id}`, async () => {
        try {
          await abandonQuest(instance.id)
          toast(`Abandoned “${instance.quest?.title}”. No XP was awarded.`, 'info')
          await activeQuests.reload()
          return true
        } catch (error) {
          toast(error.message, 'error')
          return false
        }
      }),
    [track, toast, activeQuests],
  )

  return { accept, complete, abandon, pending }
}
