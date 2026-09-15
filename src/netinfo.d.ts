declare module '@react-native-community/netinfo' {
  export interface NetInfoState {
    isConnected: boolean | null;
    isInternetReachable: boolean | null;
  }
  const NetInfo: {
    addEventListener(listener: (state: NetInfoState) => void): () => void;
  };
  export default NetInfo;
}
