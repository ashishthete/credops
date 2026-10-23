import { contextBridge, ipcRenderer } from 'electron'
import { createBridge } from './bridge'

contextBridge.exposeInMainWorld('credops', createBridge(ipcRenderer))
