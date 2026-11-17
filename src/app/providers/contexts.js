import { createContext, useContext } from 'react'

export const AuthContext = createContext(null)
export const ProfileContext = createContext(null)
export const PlayerDataContext = createContext(null)
export const RewardContext = createContext(null)
export const FocusContext = createContext(null)

function useRequired(context, name) {
  const value = useContext(context)
  if (!value) throw new Error(`${name} must be used inside its provider`)
  return value
}

export const useAuth = () => useRequired(AuthContext, 'useAuth')
export const useProfile = () => useRequired(ProfileContext, 'useProfile')
export const usePlayerData = () => useRequired(PlayerDataContext, 'usePlayerData')
export const useRewards = () => useRequired(RewardContext, 'useRewards')
export const useFocus = () => useRequired(FocusContext, 'useFocus')
