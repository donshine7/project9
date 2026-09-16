Attribute VB_Name = "HiworksRulesFinal"
Option Explicit

' Final Hiworks classification policy.
' Only newly arrived messages in the target Hiworks store are evaluated.
' An empty destination means that the message stays in Inbox.

Private Const TARGET_STORE_DISPLAY_NAME As String = "jtjang@sspat.net"

Public Sub ClassifyIncomingMail(ByVal entryId As String)
    On Error GoTo CleanExit

    Dim itemObject As Object
    Dim targetStore As Outlook.Store

    ' Entry IDs in a secondary store (the Hiworks account) must be opened
    ' with that store's StoreID.  Without it Outlook can return Nothing and
    ' the error handler silently leaves the message in Inbox.
    Set targetStore = FindTargetStore()
    If targetStore Is Nothing Then Exit Sub

    On Error Resume Next
    Set itemObject = Application.Session.GetItemFromID(entryId, targetStore.StoreID)
    On Error GoTo CleanExit
    If itemObject Is Nothing Then Exit Sub
    ClassifyMailObject itemObject, targetStore

CleanExit:
End Sub

' Classifies an already-open Outlook item.  This avoids a second EntryID lookup,
' which is unreliable for some POP/secondary stores even when the item is in the
' correct Hiworks Inbox.
Private Sub ClassifyMailObject(ByVal itemObject As Object, ByVal targetStore As Outlook.Store)
    On Error GoTo CleanExit

    Dim mail As Outlook.MailItem
    Dim parentFolder As Outlook.Folder
    Dim destination As Outlook.Folder
    Dim destinationName As String

    If itemObject Is Nothing Then Exit Sub
    If Not TypeOf itemObject Is Outlook.MailItem Then Exit Sub
    Set mail = itemObject

    Set parentFolder = mail.Parent
    If parentFolder Is Nothing Then Exit Sub
    If parentFolder.StoreID <> targetStore.StoreID Then Exit Sub

    destinationName = GetDestinationName(mail)
    If Len(destinationName) = 0 Then Exit Sub

    ' All classification folders are direct children of the Hiworks store root.
    ' Searching only the root prevents accidentally moving mail into a deleted
    ' folder with the same name.
    Set destination = FindTopLevelFolder(targetStore.GetRootFolder, destinationName)
    If destination Is Nothing Then Exit Sub

    mail.Move destination

CleanExit:
End Sub

' Reclassifies only the messages selected in the current Outlook explorer.
' Select today's Hiworks messages and run this macro once to apply the same
' rules to existing mail; new mail continues to use Application_NewMailEx.
Public Sub ReclassifySelectedHiworksMail()
    On Error GoTo CleanExit

    Dim selectedItems As Outlook.Selection
    Dim selectedItem As Object

    Set selectedItems = Application.ActiveExplorer.Selection
    For Each selectedItem In selectedItems
        If TypeOf selectedItem Is Outlook.MailItem Then
            ClassifyIncomingMail selectedItem.EntryID
        End If
    Next selectedItem

CleanExit:
End Sub

' Repairs existing series cases that were previously placed in the overseas
' patent folder before the domestic-series rule was added.
Public Sub ReclassifyDomesticPatentSeriesMail()
    On Error GoTo CleanExit

    Dim targetStore As Outlook.Store
    Dim sourceFolder As Outlook.Folder
    Dim itemObject As Object
    Dim itemIndex As Long

    Set targetStore = FindTargetStore()
    If targetStore Is Nothing Then Exit Sub
    Set sourceFolder = FindTopLevelFolder(targetStore.GetRootFolder, "해외 특허")
    If sourceFolder Is Nothing Then Exit Sub

    For itemIndex = sourceFolder.Items.Count To 1 Step -1
        Set itemObject = sourceFolder.Items.Item(itemIndex)
        If TypeOf itemObject Is Outlook.MailItem Then
            If HasDomesticPatentSeries(NzText(itemObject.Subject)) Then
                ClassifyMailObject itemObject, targetStore
            End If
        End If
    Next itemIndex

CleanExit:
End Sub

' Repairs existing EASYPAT_S OA assignment notices that were previously
' placed in the overseas patent folder before the body-template exception.
Public Sub ReclassifyDomesticOaAssignmentMail()
    On Error GoTo CleanExit

    Dim targetStore As Outlook.Store
    Dim sourceFolder As Outlook.Folder
    Dim itemObject As Object
    Dim itemIndex As Long

    Set targetStore = FindTargetStore()
    If targetStore Is Nothing Then Exit Sub
    Set sourceFolder = FindTopLevelFolder(targetStore.GetRootFolder, "해외 특허")
    If sourceFolder Is Nothing Then Exit Sub

    For itemIndex = sourceFolder.Items.Count To 1 Step -1
        Set itemObject = sourceFolder.Items.Item(itemIndex)
        If TypeOf itemObject Is Outlook.MailItem Then
            If IsDomesticOaAssignment( _
                NzText(itemObject.Subject), _
                ExtractNewBody(NzText(itemObject.Body))) Then
                ClassifyMailObject itemObject, targetStore
            End If
        End If
    Next itemIndex

CleanExit:
End Sub

' Reclassifies today's messages currently in the Hiworks Inbox without
' opening them or relying on the Explorer selection.
Public Sub ReclassifyTodayHiworksMail()
    On Error GoTo CleanExit

    Dim targetStore As Outlook.Store
    Dim inboxFolder As Outlook.Folder
    Dim itemObject As Object
    Dim itemIndex As Long
    Dim itemCount As Long
    Dim todayStart As Date
    Dim tomorrowStart As Date

    Set targetStore = FindTargetStore()
    If targetStore Is Nothing Then Exit Sub
    Set inboxFolder = targetStore.GetDefaultFolder(olFolderInbox)
    If inboxFolder Is Nothing Then Exit Sub

    todayStart = Date
    tomorrowStart = DateAdd("d", 1, todayStart)

    ' Walk backwards because moving an item changes the collection indexes.
    itemCount = inboxFolder.Items.Count
    For itemIndex = itemCount To 1 Step -1
        Set itemObject = inboxFolder.Items.Item(itemIndex)
        If TypeOf itemObject Is Outlook.MailItem Then
            If itemObject.ReceivedTime >= todayStart And _
               itemObject.ReceivedTime < tomorrowStart Then
                ClassifyMailObject itemObject, targetStore
            End If
        End If
    Next itemIndex

CleanExit:
End Sub

Private Function GetDestinationName(ByVal mail As Outlook.MailItem) As String
    Dim senderAddress As String
    Dim subjectText As String
    Dim compactSubject As String
    Dim newBody As String
    Dim isOverseas As Boolean
    Dim hasP As Boolean
    Dim hasT As Boolean
    Dim hasD As Boolean
    Dim domesticTypeCount As Long

    senderAddress = GetSenderSmtpAddress(mail)
    subjectText = NzText(mail.Subject)
    compactSubject = RemoveWhitespace(subjectText)
    newBody = ExtractNewBody(NzText(mail.Body))

    ' 1-3. Fixed messages sent from the office automation address.
    If senderAddress = "sspat99@sspat.net" Then
        If ContainsText(subjectText, "해외출원안내") Then
            GetDestinationName = "해외 출원 자동 안내"
            Exit Function
        End If

        If ContainsText(subjectText, "입금내역이 추가되었습니다") Then
            GetDestinationName = "입금 내역"
            Exit Function
        End If

        If ContainsText(subjectText, "EasyPAT 결재 시스템") Then
            GetDestinationName = "결재"
            Exit Function
        End If
    End If

    ' 4. Korean Patent Attorneys Association condolence notices sometimes use
    ' a relay sender. The confirmed subject template takes priority by itself.
    ' Verified examples include Kim Sung-gyu's mother and Kim Nam-myeong's father.
    If ContainsText(compactSubject, "(경조사)회원") _
        And ContainsText(compactSubject, "변리사") Then
        GetDestinationName = "대한변리사회 - 경조사"
        Exit Function
    End If

    ' 4-6. Korean Patent Attorneys Association. Every sender in the confirmed
    ' kpaa.or.kr domain follows the same three-way folder policy.
    ' edu@kpaa.or.kr mandatory-training / fine-notification notices are education.
    ' Deploy this condition to HiworksRulesFinal: NewMailEx does not call HiworksRules.
    If LCase$(Right$(Trim$(senderAddress), Len("@kpaa.or.kr"))) = "@kpaa.or.kr" Then
        If ContainsText(subjectText, "경조사") Then
            GetDestinationName = "대한변리사회 - 경조사"
        ElseIf ContainsText(subjectText, "연수") Then
            GetDestinationName = "대한변리사회 - 교육"
        Else
            GetDestinationName = "대한변리사회 - 기타"
        End If
        Exit Function
    End If

    ' 7. Deadline-list handoff notices. Dates and spacing may vary, so the
    ' stable subject markers are evaluated after whitespace is removed.
    If ContainsText(compactSubject, "[업무전달]") _
        And ContainsText(compactSubject, "마감리스트") _
        And ContainsText(compactSubject, "송부의건") Then
        GetDestinationName = "기일관리"
        Exit Function
    End If

    ' 8. Automatic government-project notices.
    If senderAddress = "1357@kised.or.kr" _
        Or ContainsText(subjectText, "모집 공고") _
        Or ContainsText(subjectText, "모집공고") _
        Or ContainsText(subjectText, "사업 공고") _
        Or ContainsText(subjectText, "사업공고") Then
        GetDestinationName = "과제 자동 안내"
        Exit Function
    End If

    ' 9. Domestic matter registration: both phrases are mandatory. Whitespace is ignored.
    If ContainsText(compactSubject, "[업무전달]") _
        And ContainsText(compactSubject, "사건등록완료") Then
        GetDestinationName = "사건등록"
        Exit Function
    End If

    ' 10. China provisional applications take priority over general overseas rules.
    If ContainsText(subjectText, "중국") And ContainsText(subjectText, "가출원") Then
        GetDestinationName = "중국 가출원"
        Exit Function
    End If

    ' 11. PI + six digits is an incoming overseas patent matter. This rule also
    ' takes priority over invoice/fee wording by explicit policy.
    If HasMatterCode(subjectText, "PI") Then
        GetDestinationName = "해외 특허"
        Exit Function
    End If

    isOverseas = IsOverseasMail(mail, subjectText, newBody)
    hasP = HasMatterCode(subjectText, "P")
    hasT = HasMatterCode(subjectText, "T")
    hasD = HasMatterCode(subjectText, "D")

    ' A domestic patent series uses a suffix such as P262000-S1.  The
    ' overseas-team participant or quoted foreign wording must not override
    ' this domestic-series signal.
    If hasP And HasDomesticPatentSeries(subjectText) Then
        isOverseas = False
    End If

    ' EASYPAT_S assignment notices are domestic OA work items. Their P-code
    ' and English field labels (OurRef/YourRef) must not send them through an
    ' overseas rule; the body template is the stronger signal here.
    If hasP And IsDomesticOaAssignment(subjectText, newBody) Then
        GetDestinationName = "국내특허 OA/ 우선심사 보완"
        Exit Function
    End If

    ' 12. Domestic patent decision receipt. PT/PI never satisfy hasP.
    ' These fixed templates are domestic patent decision follow-ups:
    ' "등록결정서 접수 보고", "특허결정서 접수 보고", and
    ' "분할여부 확인요청". Check this before the generic domestic patent
    ' rule so these messages cannot fall through to "국내 특허".
    If Not isOverseas And hasP Then
        If ContainsText(compactSubject, "등록결정서접수보고") _
            Or ContainsText(compactSubject, "특허결정서접수보고") _
            Or ContainsText(compactSubject, "분할여부확인요청") Then
            GetDestinationName = "국내특허 등록결정"
            Exit Function
        End If
    End If

    ' 13. Fixed domestic OA / accelerated-examination supplement templates.
    If Not isOverseas And hasP Then
        If ContainsText(compactSubject, "[업무요청]의견제출통지서대응") _
            Or ContainsText(compactSubject, "[업무요청]우선심사신청보완요구서") Then
            GetDestinationName = "국내특허 OA/ 우선심사 보완"
            Exit Function
        End If
    End If

    ' 14. Project mail requires both a project-team participant and a project clue.
    If Not isOverseas And IsProjectRelated(mail, subjectText, newBody) Then
        GetDestinationName = "과제 관련"
        Exit Function
    End If

    ' 15-18. Overseas matters. Finance takes priority except for PI matters above.
    If isOverseas Then
        If IsOverseasFinance(subjectText, newBody) Then
            GetDestinationName = "해외 견적/청구/정산"
            Exit Function
        End If

        If IsOverseasDesign(subjectText, newBody) Then
            GetDestinationName = "해외 디자인"
            Exit Function
        End If

        If IsOverseasTrademark(subjectText, newBody) Then
            GetDestinationName = "해외 상표"
            Exit Function
        End If

        If IsOverseasPatent(subjectText, newBody) Then
            GetDestinationName = "해외 특허"
            Exit Function
        End If
    End If

    ' 19-21. A domestic matter must contain exactly one P/T/D matter type.
    If hasP Then domesticTypeCount = domesticTypeCount + 1
    If hasT Then domesticTypeCount = domesticTypeCount + 1
    If hasD Then domesticTypeCount = domesticTypeCount + 1

    If Not isOverseas And domesticTypeCount = 1 Then
        If hasP Then
            GetDestinationName = "국내 특허"
        ElseIf hasT Then
            GetDestinationName = "국내 상표"
        ElseIf hasD Then
            GetDestinationName = "국내 디자인"
        End If
        Exit Function
    End If

    ' 22. A confirmed overseas matter that could not be typed more specifically.
    If isOverseas Then
        GetDestinationName = "해외 기타"
        Exit Function
    End If

    ' No catch-all folder: unclassified mail remains in Inbox.
End Function

Private Function IsOverseasMail( _
    ByVal mail As Outlook.MailItem, _
    ByVal subjectText As String, _
    ByVal newBody As String) As Boolean

    Dim hasOverseasTeam As Boolean

    ' The mailbox owner's presence as a recipient is deliberately ignored because
    ' nearly every incoming message is addressed to jtjang@sspat.net.
    hasOverseasTeam = _
        MessageHasParticipant(mail, "mslee@sspat.net") _
        Or MessageHasParticipant(mail, "hjlee@sspat.net") _
        Or GetSenderSmtpAddress(mail) = "jtjang@sspat.net"

    If hasOverseasTeam And HasForeignClue(subjectText, newBody) Then
        IsOverseasMail = True
        Exit Function
    End If

    ' English-only subject plus English-only newly written body is an independent
    ' overseas signal. Quoted history and common signature blocks are excluded.
    If IsEnglishText(subjectText, 4) And IsEnglishText(newBody, 10) Then
        IsOverseasMail = True
    End If
End Function

Private Function HasForeignClue(ByVal subjectText As String, ByVal newBody As String) As Boolean
    Dim combinedText As String
    combinedText = subjectText & vbLf & Left$(newBody, 4000)

    If ContainsAny(combinedText, Array( _
        "해외", "국제출원", "국제단계", "국내단계", "외국", _
        "미국", "일본", "중국", "유럽", "대만", "인도", "캐나다", _
        "호주", "영국", "독일", "프랑스", "싱가포르", "베트남", _
        "태국", "인도네시아", "말레이시아", "필리핀", "브라질", _
        "멕시코", "러시아", "카자흐스탄", "사우디", "아랍에미리트", _
        "PCT", "WIPO", "USPTO", "EPO", "JPO", "CNIPA", "EUIPO", _
        "foreign", "overseas", "international", "national phase", _
        "office action", "annuity", "prosecution", "Madrid", "Hague")) Then
        HasForeignClue = True
        Exit Function
    End If

    If HasMatterCode(subjectText, "PT") Then
        HasForeignClue = True
        Exit Function
    End If

    ' Examples: P211758-PCT-EP, T261420-UA, D231154-JP.
    HasForeignClue = RegexTest(subjectText, _
        "(^|[^A-Z0-9])[PTD][0-9]{6}-(PCT-)?[A-Z]{2}([^A-Z]|$)")
End Function

Private Function IsOverseasFinance(ByVal subjectText As String, ByVal newBody As String) As Boolean
    IsOverseasFinance = ContainsAny(subjectText & vbLf & Left$(newBody, 4000), Array( _
        "견적", "청구", "정산", "비용", "송금", "입금", _
        "quotation", "quote", "estimate", "invoice", "billing", _
        "fee", "fees", "remittance", "payment", "debit note", "credit note"))
End Function

Private Function IsOverseasPatent(ByVal subjectText As String, ByVal newBody As String) As Boolean
    If HasMatterCode(subjectText, "P") Or HasMatterCode(subjectText, "PT") Then
        IsOverseasPatent = True
        Exit Function
    End If

    IsOverseasPatent = ContainsAny(subjectText & vbLf & Left$(newBody, 4000), Array( _
        "특허", "patent", "PCT", "office action", "annuity", _
        "prosecution", "national phase", "USPTO", "EPO", "JPO", "CNIPA"))
End Function

Private Function IsOverseasTrademark(ByVal subjectText As String, ByVal newBody As String) As Boolean
    If HasMatterCode(subjectText, "T") Then
        IsOverseasTrademark = True
        Exit Function
    End If

    IsOverseasTrademark = ContainsAny(subjectText & vbLf & Left$(newBody, 4000), Array( _
        "상표", "trademark", "trade mark", "Madrid", "EUIPO"))
End Function

Private Function IsOverseasDesign(ByVal subjectText As String, ByVal newBody As String) As Boolean
    If HasMatterCode(subjectText, "D") Then
        IsOverseasDesign = True
        Exit Function
    End If

    IsOverseasDesign = ContainsAny(subjectText & vbLf & Left$(newBody, 4000), Array( _
        "디자인", "industrial design", "design application", "Hague"))
End Function

Private Function IsProjectRelated( _
    ByVal mail As Outlook.MailItem, _
    ByVal subjectText As String, _
    ByVal newBody As String) As Boolean

    Dim hasProjectTeam As Boolean
    hasProjectTeam = _
        MessageHasParticipant(mail, "jykim@sspat.net") _
        Or MessageHasParticipant(mail, "hwlee@sspat.net") _
        Or MessageHasParticipant(mail, "shchoi@sspat.net")

    If Not hasProjectTeam Then Exit Function

    IsProjectRelated = ContainsAny(subjectText & vbLf & Left$(newBody, 4000), Array( _
        "과제", "정부지원", "지원사업", "사업계획", "협약", "사업비", _
        "연구개발", "R&D", "중간보고", "최종보고", "연차보고", "성과보고"))
End Function

Private Function MessageHasParticipant( _
    ByVal mail As Outlook.MailItem, _
    ByVal smtpAddress As String) As Boolean

    Dim recipient As Outlook.Recipient
    Dim recipientAddress As String

    smtpAddress = LCase$(Trim$(smtpAddress))
    If GetSenderSmtpAddress(mail) = smtpAddress Then
        MessageHasParticipant = True
        Exit Function
    End If

    On Error Resume Next
    For Each recipient In mail.Recipients
        If recipient.Type = olTo Or recipient.Type = olCC Then
            recipientAddress = GetAddressEntrySmtpAddress(recipient.AddressEntry)
            If Len(recipientAddress) = 0 Then recipientAddress = LCase$(Trim$(recipient.Address))
            If recipientAddress = smtpAddress Then
                MessageHasParticipant = True
                Exit Function
            End If
        End If
    Next recipient
End Function

Private Function GetSenderSmtpAddress(ByVal mail As Outlook.MailItem) As String
    Dim addressText As String
    Dim senderEntry As Outlook.AddressEntry

    On Error Resume Next

    addressText = LCase$(Trim$(mail.SenderEmailAddress))
    Set senderEntry = mail.Sender
    If Not senderEntry Is Nothing Then
        If UCase$(mail.SenderEmailType) = "EX" Then
            addressText = GetAddressEntrySmtpAddress(senderEntry)
        ElseIf InStr(1, addressText, "@", vbTextCompare) = 0 Then
            addressText = GetAddressEntrySmtpAddress(senderEntry)
        End If
    End If

    GetSenderSmtpAddress = LCase$(Trim$(addressText))
End Function

Private Function GetAddressEntrySmtpAddress(ByVal entry As Outlook.AddressEntry) As String
    Dim exchangeUser As Outlook.ExchangeUser
    Dim addressText As String

    On Error Resume Next
    If entry Is Nothing Then Exit Function

    addressText = entry.Address
    If UCase$(entry.Type) = "EX" Then
        Set exchangeUser = entry.GetExchangeUser
        If Not exchangeUser Is Nothing Then addressText = exchangeUser.PrimarySmtpAddress
        If InStr(1, addressText, "@", vbTextCompare) = 0 Then
            addressText = entry.PropertyAccessor.GetProperty( _
                "http://schemas.microsoft.com/mapi/proptag/0x39FE001E")
        End If
    End If

    GetAddressEntrySmtpAddress = LCase$(Trim$(addressText))
End Function

Private Function HasMatterCode(ByVal sourceText As String, ByVal codePrefix As String) As Boolean
    HasMatterCode = RegexTest(sourceText, _
        "(^|[^A-Z0-9])" & UCase$(codePrefix) & "[0-9]{6}([^A-Z0-9]|$)")
End Function

Private Function HasDomesticPatentSeries(ByVal sourceText As String) As Boolean
    ' Domestic patent series examples: P262000-S1, P262000-S2, P262000-S3.
    ' Domestic division applications use the related P######-DIV1 form.
    HasDomesticPatentSeries = _
        RegexTest(sourceText, "(^|[^A-Z0-9])P[0-9]{6}-S[0-9]+([^A-Z0-9]|$)") _
        Or RegexTest(sourceText, "(^|[^A-Z0-9])P[0-9]{6}-DIV[0-9]+([^A-Z0-9]|$)")
End Function

Private Function IsDomesticOaAssignment( _
    ByVal subjectText As String, _
    ByVal newBody As String) As Boolean

    Dim compactSubject As String
    Dim compactBody As String

    compactSubject = RemoveWhitespace(subjectText)
    compactBody = RemoveWhitespace(newBody)

    If Not ContainsText(compactSubject, "[EASYPAT_S]") Then Exit Function

    IsDomesticOaAssignment = _
        ContainsText(compactBody, "업무구분:OA") _
        Or ContainsText(compactBody, "업무내용:의견/보정서작성") _
        Or ContainsText(compactBody, "담당자업무:의견/보정서작성")
End Function

Private Function RegexTest(ByVal sourceText As String, ByVal patternText As String) As Boolean
    Dim expression As Object
    On Error GoTo NotMatched

    Set expression = CreateObject("VBScript.RegExp")
    expression.Global = False
    expression.IgnoreCase = True
    expression.Pattern = patternText
    RegexTest = expression.Test(sourceText)
    Exit Function

NotMatched:
    RegexTest = False
End Function

Private Function IsEnglishText(ByVal sourceText As String, ByVal minimumLetters As Long) As Boolean
    Dim expression As Object
    Dim matches As Object

    sourceText = Trim$(sourceText)
    If Len(sourceText) = 0 Then Exit Function

    ' Any Korean or CJK ideograph means the text is not English-only.
    ' ChrW keeps the CJK endpoint intact when the editor saves as Korean ANSI.
    If RegexTest(sourceText, "[가-힣ㄱ-ㅎㅏ-ㅣ" & ChrW(&H4E00) & "-" & ChrW(&H9FA5) & "]") Then Exit Function

    Set expression = CreateObject("VBScript.RegExp")
    expression.Global = True
    expression.IgnoreCase = True
    expression.Pattern = "[A-Z]"
    Set matches = expression.Execute(sourceText)
    IsEnglishText = (matches.Count >= minimumLetters)
End Function

Private Function ExtractNewBody(ByVal bodyText As String) As String
    Dim normalizedText As String
    Dim lines As Variant
    Dim oneLine As Variant
    Dim trimmedLine As String
    Dim lowerLine As String
    Dim resultText As String
    Dim lineNumber As Long

    normalizedText = Replace(bodyText, vbCrLf, vbLf)
    normalizedText = Replace(normalizedText, vbCr, vbLf)
    lines = Split(normalizedText, vbLf)

    For Each oneLine In lines
        trimmedLine = Trim$(CStr(oneLine))
        lowerLine = LCase$(trimmedLine)

        If ContainsText(lowerLine, "-----original message-----") Then Exit For
        If trimmedLine = "________________________________" Then Exit For
        If Left$(trimmedLine, 5) = "보낸 사람" Then Exit For
        If lineNumber > 2 And Left$(lowerLine, 5) = "from:" Then Exit For
        If lineNumber > 2 And Left$(lowerLine, 3) = "on " _
            And ContainsText(lowerLine, " wrote:") Then Exit For

        If lineNumber > 1 Then
            If lowerLine = "--" _
                Or lowerLine = "best regards," _
                Or lowerLine = "best regards" _
                Or lowerLine = "kind regards," _
                Or lowerLine = "kind regards" _
                Or lowerLine = "regards," _
                Or lowerLine = "regards" _
                Or lowerLine = "sincerely," _
                Or lowerLine = "sincerely" _
                Or lowerLine = "yours faithfully," _
                Or lowerLine = "yours faithfully" Then Exit For
        End If

        resultText = resultText & CStr(oneLine) & vbLf
        lineNumber = lineNumber + 1
    Next oneLine

    ExtractNewBody = Trim$(resultText)
End Function

Private Function RemoveWhitespace(ByVal sourceText As String) As String
    sourceText = Replace(sourceText, " ", "")
    sourceText = Replace(sourceText, vbTab, "")
    sourceText = Replace(sourceText, vbCr, "")
    sourceText = Replace(sourceText, vbLf, "")
    sourceText = Replace(sourceText, ChrW(160), "")
    RemoveWhitespace = sourceText
End Function

Private Function ContainsAny(ByVal sourceText As String, ByVal searchTerms As Variant) As Boolean
    Dim oneTerm As Variant
    For Each oneTerm In searchTerms
        If ContainsText(sourceText, CStr(oneTerm)) Then
            ContainsAny = True
            Exit Function
        End If
    Next oneTerm
End Function

Private Function ContainsText(ByVal sourceText As String, ByVal searchText As String) As Boolean
    ContainsText = (InStr(1, sourceText, searchText, vbTextCompare) > 0)
End Function

Private Function NzText(ByVal sourceValue As Variant) As String
    If IsNull(sourceValue) Or IsEmpty(sourceValue) Then
        NzText = vbNullString
    Else
        NzText = CStr(sourceValue)
    End If
End Function

Private Function FindTargetStore() As Outlook.Store
    Dim oneStore As Outlook.Store

    For Each oneStore In Application.Session.Stores
        If StrComp(oneStore.DisplayName, TARGET_STORE_DISPLAY_NAME, vbTextCompare) = 0 Then
            Set FindTargetStore = oneStore
            Exit Function
        End If
    Next oneStore
End Function

Private Function FindTopLevelFolder( _
    ByVal rootFolder As Outlook.Folder, _
    ByVal targetName As String) As Outlook.Folder

    Dim child As Outlook.Folder

    On Error Resume Next
    For Each child In rootFolder.Folders
        If StrComp(child.Name, targetName, vbTextCompare) = 0 Then
            Set FindTopLevelFolder = child
            Exit Function
        End If
    Next child
End Function
