/**
 * Test helper: a stateful fake PnP tenant for the SharePoint structure restore and its
 * live proof. Reads answer from its state and writes change it, behind the real
 * engine/powershell/jobQueue.mjs spawn path and the allowlists parsed from
 * ops/powershell/run-cmdlet.ps1. Nothing here touches a tenant.
 */
import { gunzipSync } from 'node:zlib';

import { containerAllowlist, fakeCmdletContainer } from './fakeCmdletContainer.mjs';

let guidSeq = 0;
export const newGuid = () => `00000000-0000-4000-8000-${String(guidSeq += 1).padStart(12, '0')}`;

export const HOST = 'contoso.sharepoint.com';
export const SITE = `https://${HOST}/sites/KEEL-RT-structure`;
export const READS = containerAllowlist('AllowedPnPStructure');
export const WRITES = containerAllowlist('AllowedPnPStructureWrites');
export const NS = 'http://schemas.dev.office.com/PnP/2022/09/ProvisioningSchema';
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One list as PnP exports it, with content and permissions a restore must never send. */
const listXml = (list) => `<pnp:ListInstance Title="${esc(list.Title)}" Url="${esc(list.Url)}" TemplateType="${list.TemplateType ?? 101}" OnQuickLaunch="true" EnableVersioning="${list.EnableVersioning ?? 'true'}" MaxVersionLimit="500">
  <pnp:ContentTypeBindings><pnp:ContentTypeBinding ContentTypeID="0x0101" Default="true" /></pnp:ContentTypeBindings>
  <pnp:Views><View DisplayName="All Documents" Url="Forms/AllItems.aspx"><ViewFields><FieldRef Name="LinkFilename" /></ViewFields></View></pnp:Views>
  <pnp:Fields><Field ID="{11111111-0000-4000-8000-000000000001}" Name="KeelRtStatus" StaticName="KeelRtStatus" DisplayName="Status" Type="Choice"><CHOICES><CHOICE>Open</CHOICE></CHOICES></Field></pnp:Fields>
  <pnp:FieldRefs><pnp:FieldRef ID="22222222-0000-4000-8000-000000000002" Name="KeelRtProject" /></pnp:FieldRefs>
  ${list.extra ?? ''}
  <pnp:DataRows><pnp:DataRow><pnp:DataValue FieldName="Title">secret row</pnp:DataValue><pnp:Security><pnp:BreakRoleInheritance CopyRoleAssignments="false" /></pnp:Security></pnp:DataRow></pnp:DataRows>
  <pnp:Security><pnp:BreakRoleInheritance CopyRoleAssignments="false" ClearSubscopes="true"><pnp:RoleAssignment Principal="Everyone" RoleDefinition="Full Control" /></pnp:BreakRoleInheritance></pnp:Security>
  <pnp:Webhooks><pnp:Webhook ServerNotificationUrl="https://example.test/hook" ExpiresInDays="90" /></pnp:Webhooks>
  <pnp:UserCustomActions><pnp:CustomAction Name="x" Location="ScriptLink" ScriptBlock="alert(1)" /></pnp:UserCustomActions>
</pnp:ListInstance>`;

/** A site's template, as Get-PnPSiteTemplate writes it, from the fake's state. */
export function templateXml(site, { id = 'T-1' } = {}) {
  return `<?xml version="1.0"?>
<pnp:Provisioning xmlns:pnp="${NS}">
  <pnp:Preferences Generator="PnP.Framework, 1.17.0" />
  <pnp:Templates ID="CONTAINER-TEMPLATE-1">
    <pnp:ProvisioningTemplate ID="${id}" Version="1" BaseSiteTemplate="SITEPAGEPUBLISHING#0" Scope="RootSite">
      <pnp:WebSettings Title="${esc(site.title)}" Description="Test site" NoCrawl="false" QuickLaunchEnabled="true" />
      <pnp:RegionalSettings LocaleId="1033" TimeZone="13" Time24="false" />
      <pnp:PropertyBagEntries><pnp:PropertyBagEntry Key="secret" Value="x" /></pnp:PropertyBagEntries>
      <pnp:Navigation><pnp:CurrentNavigation NavigationType="StructuralLocal"><pnp:StructuralNavigation RemoveExistingNodes="false">${site.nav.map((title) => `<pnp:NavigationNode Title="${esc(title)}" Url="/sites/KEEL-RT-structure/${esc(title)}" IsExternal="false" />`).join('')}</pnp:StructuralNavigation></pnp:CurrentNavigation></pnp:Navigation>
      <pnp:SiteFields>${site.columns.map((column) => `<Field ID="{${column.ID}}" Name="${esc(column.Name)}" StaticName="${esc(column.Name)}" DisplayName="${esc(column.Name)}" Type="${column.Type ?? 'Text'}" Group="KEEL-RT columns" />`).join('')}</pnp:SiteFields>
      <pnp:ContentTypes>${site.types.map((type) => `<pnp:ContentType ID="${type.ID}" Name="${esc(type.Name)}" Group="KEEL-RT types" Description=""><pnp:FieldRefs><pnp:FieldRef ID="22222222-0000-4000-8000-000000000002" Name="KeelRtProject" /></pnp:FieldRefs>${type.extra ?? ''}</pnp:ContentType>`).join('')}</pnp:ContentTypes>
      <pnp:Lists>${site.lists.map(listXml).join('')}</pnp:Lists>
      <pnp:Features><pnp:SiteFeatures><pnp:Feature ID="b50e3104-6812-424f-a011-cc90e6327318" /></pnp:SiteFeatures></pnp:Features>
    </pnp:ProvisioningTemplate>
  </pnp:Templates>
</pnp:Provisioning>`;
}

export const attr = (text, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1] ?? null;

/** The fake's state: what the backup sees before anything is changed. */
export function initialState() {
  const scriptId = newGuid();
  return {
    sites: {
      [SITE.toLowerCase()]: {
        title: 'KEEL-RT structure',
        lists: [{ Title: 'Documents', Url: 'Shared Documents' }, { Title: 'KEEL-RT tasks', Url: 'Lists/KEEL-RT tasks', TemplateType: 100 }],
        columns: [{ ID: '22222222-0000-4000-8000-000000000002', Name: 'KeelRtProject' }, { ID: '33333333-0000-4000-8000-000000000003', Name: 'KeelRtOwner' }],
        types: [{ ID: '0x0100AA', Name: 'KEEL-RT item' }],
        nav: ['Home', 'KEEL-RT tasks'],
      },
    },
    hubs: [{ ID: newGuid(), Title: 'KEEL-RT-hub', SiteUrl: SITE, SiteId: newGuid(), Description: 'the hub', LogoUrl: '', SiteDesignId: '00000000-0000-0000-0000-000000000000', RequiresJoinApproval: false, HideNameInNavigation: false, ParentHubSiteId: '00000000-0000-0000-0000-000000000000' }],
    scripts: [{ Id: scriptId, Title: 'KEEL-RT-script', Description: 's', Content: '{"actions":[{"verb":"createSPList","listName":"KEEL-RT list"}]}', Version: 1 }],
    designs: [{ Id: newGuid(), Title: 'KEEL-RT-design', Description: 'd', WebTemplate: '64', SiteScriptIds: [scriptId], PreviewImageUrl: '', PreviewImageAltText: '', IsDefault: false, Version: 1 }],
  };
}

/** A stateful fake PnP tenant: reads answer from `state`, writes change it. */
export function fakeTenant(state = initialState(), { crash = [] } = {}) {
  const writes = [];
  const container = fakeCmdletContainer({
    module: 'PnP.PowerShell',
    allowlist: { ...READS, ...WRITES },
    answer: (cmdlet, parameters) => {
      if (cmdlet === 'Get-PnPHubSite') return state.hubs;
      if (cmdlet === 'Get-PnPSiteDesign') return state.designs;
      if (cmdlet === 'Get-PnPSiteScript') {
        if (!parameters.Identity) return state.scripts.map(({ Content, ...listed }) => listed);
        return state.scripts.filter((script) => script.Id === parameters.Identity);
      }
      if (cmdlet === 'Get-PnPSiteTemplate') {
        const site = state.sites[String(parameters.Url).toLowerCase()];
        return site ? [templateXml(site)] : { error: { message: 'File Not Found.', category: 'NotSpecified', errorId: 'x' } };
      }
      writes.push({ cmdlet, parameters });
      if (crash.includes(cmdlet)) return 'crash';
      if (cmdlet === 'Invoke-PnPSiteTemplate') {
        const xml = gunzipSync(Buffer.from(parameters.TemplateGzip, 'base64')).toString('utf8');
        writes.at(-1).xml = xml;
        const site = state.sites[String(parameters.Url).toLowerCase()];
        const siteFields = /<pnp:SiteFields>([\s\S]*?)<\/pnp:SiteFields>/.exec(xml)?.[1] ?? '';
        for (const [field] of siteFields.matchAll(/<Field\b[^>]*>/g)) {
          const id = attr(field, 'ID').replace(/[{}]/g, '');
          if (!site.columns.some((column) => column.ID === id)) site.columns.push({ ID: id, Name: attr(field, 'Name') });
        }
        for (const [type] of xml.matchAll(/<pnp:ContentType\b[^>]*>/g)) {
          if (!site.types.some((item) => item.ID === attr(type, 'ID'))) site.types.push({ ID: attr(type, 'ID'), Name: attr(type, 'Name') });
        }
        for (const [list] of xml.matchAll(/<pnp:ListInstance\b[^>]*>/g)) {
          if (!site.lists.some((item) => item.Url === attr(list, 'Url'))) site.lists.push({ Title: attr(list, 'Title'), Url: attr(list, 'Url'), TemplateType: Number(attr(list, 'TemplateType')) });
        }
        if (xml.includes('<pnp:Navigation')) site.nav = [...xml.matchAll(/<pnp:NavigationNode\b[^>]*>/g)].map(([node]) => attr(node, 'Title'));
        return [];
      }
      if (cmdlet === 'Register-PnPHubSite') {
        const hub = { ID: newGuid(), Title: 'KEEL-RT-structure', SiteUrl: parameters.Site, SiteId: newGuid(), Description: '', LogoUrl: '', SiteDesignId: '00000000-0000-0000-0000-000000000000', RequiresJoinApproval: false, HideNameInNavigation: false, ParentHubSiteId: '00000000-0000-0000-0000-000000000000' };
        state.hubs.push(hub);
        return [hub];
      }
      if (cmdlet === 'Set-PnPHubSite') {
        const hub = state.hubs.find((item) => item.SiteUrl.toLowerCase() === String(parameters.Identity).toLowerCase());
        const { Identity, ...fields } = parameters;
        Object.assign(hub, fields);
        return [hub];
      }
      const [list, add] = cmdlet.endsWith('SiteScript') ? [state.scripts, cmdlet.startsWith('Add-')] : [state.designs, cmdlet.startsWith('Add-')];
      if (add) {
        const body = { Id: newGuid(), Version: 1, Description: '', ...parameters };
        list.push(body);
        return [body];
      }
      const target = list.find((item) => item.Id === parameters.Identity);
      const { Identity, ...fields } = parameters;
      Object.assign(target, fields);
      return [target];
    },
  });
  return { ...container, state, writes };
}
