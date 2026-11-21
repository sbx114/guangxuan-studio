Unicode true
ManifestLongPathAware true
RequestExecutionLevel user
CRCCheck force
SetCompressor /SOLID zlib
SetDatablockOptimize on
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
${StrStr}
Name "Gx"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\GuangxuanStudio"
InstallDirRegKey HKCU "${APP_REGKEY}" "InstallPath"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Gx"
VIAddVersionKey /LANG=1033 "FileDescription" "Gx Windows Installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (c) 2026 sbx114 and Guangxuan Studio contributors"
BrandingText "Gx ${APP_VERSION}"
!define MUI_ICON "${PAYLOAD_ROOT}\resources\app\desktop\icon.ico"
!define MUI_UNICON "${PAYLOAD_ROOT}\resources\app\desktop\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 Gx ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "AI 文案、原生剪辑与论文视觉小说桌面工作台。$\r$\n$\r$\n无需管理员权限或预装 Node.js。首次启动需联网，从官方来源下载并校验视频工具。项目及模型设置保存在当前账户的应用数据目录。$\r$\n$\r$\n继续安装前请关闭已打开的 Gx。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Gx.exe"
!define MUI_FINISHPAGE_RUN_TEXT "运行 Gx"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PAYLOAD_ROOT}\resources\app\LICENSE"
!insertmacro MUI_PAGE_COMPONENTS
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateDirectoryPage
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Var DirectoryProblem
Var ExistingItem

Function ValidateInstallDirectory
  StrCpy $DirectoryProblem ""
  StrCmp $INSTDIR "" reject_root
  StrCpy $0 $INSTDIR
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0)i.r2'
  IntCmp $2 0 reject_root
  IntCmp $2 ${NSIS_MAX_STRLEN} reject_root 0 reject_root
  StrCpy $INSTDIR $1
  ${GetRoot} "$INSTDIR" $0
  StrCmp $INSTDIR "$0\" reject_root
  StrCmp $INSTDIR $0 reject_root
  StrCmp $INSTDIR "" reject_root
  ; Reject application data and Windows system locations, including children.
  Push "$LOCALAPPDATA\GuangxuanStudio"
  Call RejectProtectedPath
  Push "$APPDATA\Guangxuan Studio"
  Call RejectProtectedPath
  Push "$WINDIR"
  Call RejectProtectedPath
  Push "$SYSDIR"
  Call RejectProtectedPath
  StrCmp $DirectoryProblem "" 0 done
  ; Existing junctions and symlinks may redirect installation outside this path.
  StrCpy $0 $INSTDIR
  check_parent:
    System::Call 'kernel32::GetFileAttributesW(w r0)i.r1'
    IntCmp $1 -1 next_parent
    IntOp $2 $1 & 0x400
    IntCmp $2 0 next_parent
    StrCpy $DirectoryProblem "安装目录不能包含符号链接或目录联接。请选择普通本地目录。"
    Goto done
  next_parent:
    ${GetParent} "$0" $2
    StrCmp $2 "" existing_directory
    StrCmp $2 $0 existing_directory
    StrCpy $0 $2
    Goto check_parent
  existing_directory:
    ; Do not overwrite an unrelated folder. Accept empty or managed Gx folders.
    IfFileExists "$INSTDIR\*.*" 0 done
    ReadINIStr $0 "$INSTDIR\.gx-installation.ini" "Installation" "App"
    StrCmp $0 "GuangxuanStudio" done
    IfFileExists "$INSTDIR\installation.json" legacy_marker empty_check
  legacy_marker:
    IfFileExists "$INSTDIR\resources\app\package.json" 0 empty_check
    ClearErrors
    FileOpen $0 "$INSTDIR\installation.json" r
    IfErrors empty_check
  legacy_read:
    ClearErrors
    FileRead $0 $1
    IfErrors legacy_close
    ${StrStr} $2 $1 '"app": "GuangxuanStudio"'
    StrCmp $2 "" legacy_read
    FileClose $0
    Goto done
  legacy_close:
    FileClose $0
  empty_check:
    StrCpy $ExistingItem ""
    ClearErrors
    FindFirst $0 $1 "$INSTDIR\*.*"
    IfErrors done
  directory_loop:
    StrCmp $1 "" directory_end
    StrCmp $1 "." directory_next
    StrCmp $1 ".." directory_next
    StrCpy $ExistingItem $1
    Goto directory_end
  directory_next:
    FindNext $0 $1
    IfErrors directory_end
    Goto directory_loop
  directory_end:
    FindClose $0
    StrCmp $ExistingItem "" done
    StrCpy $DirectoryProblem "该文件夹已有其他文件。请选择空文件夹或已有的 Gx 安装目录。"
    Goto done
  reject_root:
    StrCpy $DirectoryProblem "请选择独立的应用安装目录。"
  done:
FunctionEnd

Function RejectProtectedPath
  Pop $0
  StrCmp $INSTDIR $0 reject 0
  StrCpy $0 "$0\"
  StrLen $1 $0
  StrCpy $2 $INSTDIR $1
  StrCmp $2 $0 reject done
  reject:
    StrCpy $DirectoryProblem "不能安装到 Windows 系统目录或 Gx 用户数据目录。"
  done:
FunctionEnd

Function ValidateDirectoryPage
  Call ValidateInstallDirectory
  StrCmp $DirectoryProblem "" done
  MessageBox MB_ICONSTOP "$DirectoryProblem"
  Abort
  done:
FunctionEnd

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "需要 64 位 Windows。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "需要 Windows 10 或更新版本。" /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

Section "Gx 主程序（必需）" SecMain
  SectionIn RO
  Call ValidateInstallDirectory
  StrCmp $DirectoryProblem "" directory_ok
  MessageBox MB_ICONSTOP "$DirectoryProblem" /SD IDOK
  SetErrorLevel 2
  Abort
  directory_ok:
  SetOutPath "$INSTDIR"
  SetOverwrite ifdiff
  File /r "${PAYLOAD_ROOT}\*.*"
  File "安装说明.txt"
  !ifdef EXTRA_NOTICES
    File "${EXTRA_NOTICES}\*.*"
  !endif
  WriteINIStr "$INSTDIR\.gx-installation.ini" "Installation" "App" "GuangxuanStudio"
  WriteINIStr "$INSTDIR\.gx-installation.ini" "Installation" "Version" "${APP_VERSION}"
  WriteINIStr "$INSTDIR\.gx-installation.ini" "Installation" "Path" "$INSTDIR"
  WriteUninstaller "$INSTDIR\卸载 Gx.exe"
  WriteRegStr HKCU "${APP_REGKEY}" "InstallPath" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "DisplayName" "Gx"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "Publisher" "sbx114 / Guangxuan Studio"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "DisplayIcon" "$INSTDIR\Gx.exe,0"
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "UninstallString" '$\"$INSTDIR\卸载 Gx.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_REGKEY}" "QuietUninstallString" '$\"$INSTDIR\卸载 Gx.exe$\" /S'
  WriteRegDWORD HKCU "${UNINSTALL_REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_REGKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINSTALL_REGKEY}" "EstimatedSize" $0
  CreateDirectory "$SMPROGRAMS\${SHORTCUT_GROUP}"
  CreateShortcut "$SMPROGRAMS\${SHORTCUT_GROUP}\Gx.lnk" "$INSTDIR\Gx.exe" "" "$INSTDIR\Gx.exe" 0 SW_SHOWNORMAL
  CreateShortcut "$SMPROGRAMS\${SHORTCUT_GROUP}\卸载 Gx.lnk" "$INSTDIR\卸载 Gx.exe" "" "$INSTDIR\Gx.exe" 0 SW_SHOWNORMAL
SectionEnd

Section /o "创建桌面快捷方式" SecDesktop
  CreateShortcut "$DESKTOP\${DESKTOP_SHORTCUT}.lnk" "$INSTDIR\Gx.exe" "" "$INSTDIR\Gx.exe" 0 SW_SHOWNORMAL
SectionEnd

Function un.onInit
  SetShellVarContext current
  ReadINIStr $0 "$INSTDIR\.gx-installation.ini" "Installation" "App"
  StrCmp $0 "GuangxuanStudio" marker_ok
  MessageBox MB_ICONSTOP "找不到有效的 Gx 安装记录，卸载已停止。" /SD IDOK
  SetErrorLevel 2
  Abort
  marker_ok:
  ReadINIStr $0 "$INSTDIR\.gx-installation.ini" "Installation" "Path"
  StrCmp $0 $INSTDIR path_record_ok
  MessageBox MB_ICONSTOP "安装目录与记录不符，卸载已停止。" /SD IDOK
  SetErrorLevel 2
  Abort
  path_record_ok:
  StrCpy $0 $INSTDIR
  un_check_parent:
    System::Call 'kernel32::GetFileAttributesW(w r0)i.r1'
    IntCmp $1 -1 un_next_parent
    IntOp $2 $1 & 0x400
    IntCmp $2 0 un_next_parent
    MessageBox MB_ICONSTOP "安装目录包含符号链接，卸载已停止。" /SD IDOK
    SetErrorLevel 2
    Abort
  un_next_parent:
    ${GetParent} "$0" $2
    StrCmp $2 "" un_guard_done
    StrCmp $2 $0 un_guard_done
    StrCpy $0 $2
    Goto un_check_parent
  un_guard_done:
FunctionEnd

Section "Uninstall"
  ; Explicit file removal keeps files created by the user and all user data.
  !include "${GENERATED_DIR}\uninstall-payload.nsh"
  Delete "$INSTDIR\.gx-installation.ini"
  Delete "$INSTDIR\卸载 Gx.exe"
  Delete "$SMPROGRAMS\${SHORTCUT_GROUP}\Gx.lnk"
  Delete "$SMPROGRAMS\${SHORTCUT_GROUP}\卸载 Gx.lnk"
  RMDir "$SMPROGRAMS\${SHORTCUT_GROUP}"
  Delete "$DESKTOP\${DESKTOP_SHORTCUT}.lnk"
  ReadRegStr $0 HKCU "${APP_REGKEY}" "InstallPath"
  StrCmp $0 $INSTDIR 0 registry_done
    DeleteRegKey HKCU "${APP_REGKEY}"
    DeleteRegKey HKCU "${UNINSTALL_REGKEY}"
  registry_done:
  RMDir "$INSTDIR"
SectionEnd
