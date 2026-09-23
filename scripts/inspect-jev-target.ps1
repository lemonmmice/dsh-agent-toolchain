param([long]$WindowHandle)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$WindowHandle)
$name = "指数`r`n├─沪深京指数`r`n└─股转指数`r`n"
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
$elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
$records = foreach ($element in $elements) {
  $current = $element.Current
  if ($current.IsOffscreen) { continue }
  [pscustomobject]@{name=$current.Name;runtimeId=($element.GetRuntimeId() -join '.');type=$current.ControlType.ProgrammaticName;class=$current.ClassName;rect=$current.BoundingRectangle.ToString();enabled=$current.IsEnabled}
}
$records | ConvertTo-Json -Depth 3
