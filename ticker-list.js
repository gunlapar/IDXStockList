// ============================================================
// Daftar Ticker Saham IDX (Bursa Efek Indonesia)
// Update: September 2026
// Total: ~900 ticker — mencakup semua sektor
// ============================================================

const IDX_TICKERS = [
  // === A ===
  "AADI","AALI","AAPH","ABBA","ABDA","ABMM","ACAP","ACES","ACST","ACIT",
  "ADCP","ADES","ADHI","ADMF","ADMG","ADMR","ADRO","AEGS","AGAR","AGII",
  "AGRS","AHAP","AIMS","AISA","AKKU","AKPI","AKRA","AKSI","ALDO","ALII",
  "ALKA","ALMI","ALTO","AMAG","AMAN","AMAR","AMFG","AMIN","AMMS","AMMN",
  "AMRT","ANDI","ANJT","ANTM","APIC","APII","APLN","APOL","ARCI","ARGO",
  "ARII","ARK","ARMY","ARNA","ARSS","ARTE","ARTI","ARTO","ASGR","ASII",
  "ASMI","ASPI","ASPR","ASRI","ASSA","ATAP","ATIC","ATLA","AUTO","AVIA",
  "AYLS",
  // === B ===
  "BACA","BAJA","BALI","BAMP","BANK","BAPA","BAPI","BATA","BAUT","BAYU",
  "BBCA","BBHI","BBKP","BBLD","BBMD","BBNI","BBRI","BBRM","BBSI","BBSS",
  "BBTN","BBYB","BCAP","BCIC","BCIP","BDKR","BDMN","BEEF","BELL","BELI",
  "BESS","BEST","BFIN","BGTG","BHAT","BHIT","BIKA","BIMA","BINA","BIPI",
  "BIRD","BISI","BJBR","BJTM","BKDP","BKSL","BLTA","BLTZ","BLUE","BMAS",
  "BMHS","BMRI","BMSR","BMTR","BNBA","BNBR","BNGA","BNII","BNLI","BOBA",
  "BOGA","BOLA","BOLT","BOMB","BONE","BOSS","BPFI","BPII","BRAU","BREN",
  "BRIA","BRIS","BRMS","BRNA","BRPT","BSBK","BSDE","BSML","BSSR","BSWD",
  "BTBR","BTLK","BTON","BTPS","BTRK","BUAH","BUDI","BUKK","BULL","BUMI",
  "BURA","BUVA","BWPT",
  // === C ===
  "CAKK","CAMP","CANI","CARE","CARS","CASA","CASH","CBDK","CBMF","CCSI",
  "CDIA","CEKA","CENT","CFIN","CGAS","CHEM","CHIP","CINT","CITY","CJRA",
  "CLEO","CLPI","CMNP","CMNT","CMPP","CMRY","CNKO","CNMA","COAL","COCO",
  "COIN","COKE","CORE","COWL","CPIN","CPRI","CPRO","CRAB","CRIS","CSMI",
  "CSRA","CTBN","CTRA","CTRP","CTRS","CTTH","CUAN","CURI",
  // === D ===
  "DAAZ","DADA","DAJK","DAYA","DCII","DEAL","DEFI","DELI","DEWA","DFAM",
  "DGIK","DGNS","DILD","DIVA","DKFT","DLTA","DMAS","DMMX","DMND","DNAR",
  "DNET","DOID","DPNS","DPUM","DRMA","DSFI","DSNG","DSSA","DUCK","DUTI",
  "DVLA","DWGL","DYAN",
  // === E ===
  "EAST","ECII","EDGE","EKAD","ELCN","ELSA","ELTY","EMAS","EMDE","EMTK",
  "ENRG","ENVY","EPIC","ERAA","ERTX","ESIP","ESSA","ESTI","ESTI","ETRA",
  "EURO","EVEN","EXCL","EXCO",
  // === F ===
  "FACE","FAPA","FAST","FATE","FILM","FINA","FIRE","FISH","FLMC","FMII",
  "FOOD","FORD","FORE","FORZ","FPNI","FREN","FUJI","FUEL",
  // === G ===
  "GAMA","GDST","GDYR","GEMA","GEMS","GGRM","GGRP","GHON","GIAA","GJTL",
  "GLSM","GLVA","GMFI","GMTD","GOAL","GOLD","GOLF","GOOD","GOTO","GPRA",
  "GPSO","GRIA","GRHA","GTBO","GTSI","GULA","GWSA",
  // === H ===
  "HADE","HAJJ","HAIS","HALO","HBAT","HEAL","HELI","HERO","HEXA","HDIT",
  "HILL","HITS","HKMU","HMSP","HOKI","HOME","HOPE","HOTL","HRME","HRTA",
  "HRUM","HUBG",
  // === I ===
  "IATA","IBFN","IBOS","IBST","ICBP","ICON","IDEA","IDPR","IFII","IFSH",
  "IGAR","IKAI","IKBI","IMAS","IMJS","IMPC","INAF","INAI","INCF","INCI",
  "INCO","INDF","INDO","INDR","INDS","INDX","INKP","INPC","INPS","INRU",
  "INTD","INTA","INTP","IPCC","IPOL","IRRA","IRSX","ISAT","ISSP","ITMG",
  "ITMA",
  // === J ===
  "JARR","JAST","JAWA","JAYA","JAZZ","JGLE","JIHD","JKON","JKSW","JMAS",
  "JPFA","JRPT","JSKY","JSMR","JTPE",
  // === K ===
  "KAEF","KARW","KBAG","KBLI","KBLM","KBLV","KBRI","KDSI","KEEN","KEJU",
  "KEJA","KENN","KETR","KIAS","KICI","KIJA","KKGI","KLBF","KLEO","KMDS",
  "KMTR","KOIN","KONI","KOPI","KOTA","KPAS","KPIG","KRAS","KREN","KRIS",
  "KRYA","KSBI","KUAS","KURA",
  // === L ===
  "LABA","LAND","LARS","LCKM","LEAD","LIFE","LINK","LION","LMAS","LMPI",
  "LMSH","LPCK","LPGI","LPIN","LPKR","LPLI","LPPF","LSIP","LTLS","LUCK",
  "LUCY","LXCR",
  // === M ===
  "MABA","MACE","MAIN","MAMI","MAMP","MANG","MAPA","MAPB","MAPI","MARK",
  "MASA","MASB","MASH","MATH","MBAP","MBMA","MBSS","MBTO","MCAS","MCOL",
  "MDIA","MDIY","MDKA","MDKI","MDLN","MEDC","MEGA","MERK","META","MFIN",
  "MFMI","MGRO","MHKI","MICE","MIDI","MIKA","MINA","MIND","MKNT","MKPI",
  "MLBI","MLIA","MLPL","MLPT","MNCN","MMLP","MOLI","MORA","MPIX","MPMX",
  "MPOW","MPPA","MPRO","MRAT","MREI","MSJA","MTDL","MTFN","MTLA","MTMH",
  "MTSM","MTWI","MYOR","MYOH",
  // === N ===
  "NAGA","NANO","NASI","NATO","NCKL","NELY","NETV","NICE","NICL","NICK",
  "NIKL","NINE","NISP","NISY","NOBU","NPGF","NRCA","NUSA","NZIA",
  // === O ===
  "OASA","OBMD","OCAP","OILS","OKAS","OMRE","ONCE","OPMS","OTOW",
  // === P ===
  "PALM","PANI","PANS","PATA","PBID","PBRX","PCAR","PDES","PEGE","PEHA",
  "PEVE","PGAS","PGEO","PGLI","PGUN","PICO","PIPA","PJAA","PJHB","PKPK",
  "PLAN","PLIN","PMJS","PMMP","PNBN","PNBS","PNGO","PNIN","PNLF","PNSE",
  "POLA","POLI","POLL","POLY","POOL","PORT","POWR","PPGL","PPRE","PPRI",
  "PPRO","PRAS","PRDA","PRIM","PSAB","PSDN","PSGO","PSHT","PSKT","PSSI",
  "PTBA","PTDU","PTIS","PTMP","PTRN","PTRO","PTPP","PTSN","PTTK","PUDP",
  "PURA","PURE","PURI","PWON","PYFA",
  // === R ===
  "RAJA","RALS","RANC","RATU","RBMS","RCCC","RDTX","REAL","RELI","RICY",
  "RIGS","RISE","RLCO","RMBA","RMKE","ROCK","RODA","RONY","ROTI","RSGK",
  "RUIS","RUNS",
  // === S ===
  "SAFE","SAGE","SAME","SAMF","SAPX","SATU","SBAT","SBLM","SBMA","SCBD",
  "SCCO","SCMA","SCNP","SDMU","SDPC","SDRA","SEMA","SFAS","SGER","SGRO",
  "SHID","SHIP","SIDO","SILO","SIMA","SIMP","SINI","SIPD","SKBM","SKLT",
  "SKRN","SLIS","SMAR","SMBR","SMCB","SMDM","SMDR","SMGR","SMIL","SMKL",
  "SMMA","SMMT","SMRA","SMRK","SMSM","SNAR","SOCI","SOFA","SOHO","SONA",
  "SOSS","SOUL","SPMA","SPTO","SQMI","SRAJ","SRIL","SRSN","SRTG","SSIA",
  "SSMS","SSTM","STAA","STAR","STAS","STKS","STTP","SUGI","SULI","SUPA",
  "SURE","SWAT",
  // === T ===
  "TALF","TAMA","TAPG","TARA","TAXI","TAYS","TBIG","TBLA","TBMS","TCID",
  "TCKP","TDPM","TECH","TEBE","TELE","TFAS","TGKA","TGRA","THAM","TINS",
  "TIRA","TIRT","TKIM","TLKM","TMPO","TNCA","TOBA","TOOL","TOPS","TOTL",
  "TOTO","TOWR","TOYS","TPMA","TPIA","TPIG","TRAM","TREN","TRIS","TRJA",
  "TRST","TRUE","TRUK","TRUS","TSPC","TSPI","TURI",
  // === U ===
  "UANG","UBEX","UCID","UHAL","ULTJ","UNIC","UNIT","UNSP","UNTR","UNVR",
  "URBN","UVCR",
  // === V ===
  "VICI","VICO","VINS","VIVA","VMRN","VRNA","VTIC",
  // === W ===
  "WAPO","WBSA","WEGE","WEHA","WGSH","WICO","WIFI","WIIM","WIKA","WINS",
  "WMPP","WMUU","WOOD","WOWS","WSBP","WTON","WULD",
  // === X ===
  "XBRI","XCBD",
  // === Y ===
  "YELO","YPAS","YULE",
  // === Z ===
  "ZBRA","ZINC","ZONE","ZYRX"
];

// Presets untuk quick scan
const IDX_LQ45 = [
  "ADRO","AMRT","ANTM","ARTO","ASII","BBCA","BBNI","BBRI","BBTN","BFIN",
  "BMRI","BRPT","BRIS","BUKA","CPIN","EMTK","ESSA","EXCL","GGRM","GOTO",
  "HRUM","ICBP","INCO","INDF","INKP","INTP","ISAT","ITMG","KLBF","MAPI",
  "MBMA","MDKA","MEDC","MIKA","PGAS","PTBA","SIDO","SMGR","SRTG","TAPG",
  "TBIG","TLKM","TOWR","TPIA","UNTR","UNVR"
];

const IDX_IDX30 = [
  "ADRO","AMRT","ASII","BBCA","BBNI","BBRI","BBTN","BMRI","BRPT","BRIS",
  "CPIN","EMTK","GOTO","HRUM","ICBP","INCO","INDF","ISAT","ITMG","KLBF",
  "MBMA","MDKA","PGAS","SIDO","SMGR","TLKM","TOWR","TPIA","UNTR","UNVR"
];
