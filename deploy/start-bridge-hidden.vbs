' start-bridge-hidden.vbs
'
' Launches start-bridge.cmd with window style 0 (hidden) and does not wait for
' it. Used by the ZenBridge scheduled task so the auto-restart loop runs in the
' background with no console window flashing on the desktop.
'
' ASCII only on purpose: wscript.exe reads this as ANSI/GBK.

Option Explicit

Dim shell, fso, scriptDir, cmdPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = scriptDir & "\..\bridge\start-bridge.cmd"

If Not fso.FileExists(cmdPath) Then
  WScript.Echo "start-bridge.cmd not found next to this VBS: " & cmdPath
  WScript.Quit 1
End If

shell.Run "cmd.exe /d /c """ & cmdPath & """", 0, False