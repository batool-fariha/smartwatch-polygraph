"""Generate a large synthetic Apple Health export (xml + zip) for stress-testing the page.

Usage: python3 tools/make_big_export.py OUT_DIR DAYS
  900 days is about 330 MB of XML, 2700 days about 1 GB.
"""
import random, zipfile, sys, os, datetime
out=sys.argv[1]; days=int(sys.argv[2]); random.seed(11)
W="Sam’s Apple Watch"; P="Sam’s iPhone"
start=datetime.date(2023,11,1)
def ts(d,m): 
    t=datetime.datetime.combine(d,datetime.time())+datetime.timedelta(minutes=m); return t.strftime('%Y-%m-%d %H:%M:%S +0000')
def rec(t,src,s,e,v,u=''):
    return f'<Record type="{t}" sourceName="{src}" sourceVersion="11.0" {("unit=%s " % chr(34)+u+chr(34)) if u else ""}creationDate="{e}" startDate="{s}" endDate="{e}" value="{v}"><MetadataEntry key="HKMetadataKeySyncIdentifier" value="{random.getrandbits(64):x}"/></Record>\n'
OTHER=['HKQuantityTypeIdentifierActiveEnergyBurned','HKQuantityTypeIdentifierBasalEnergyBurned','HKQuantityTypeIdentifierDistanceWalkingRunning','HKQuantityTypeIdentifierFlightsClimbed','HKQuantityTypeIdentifierAppleExerciseTime','HKQuantityTypeIdentifierWalkingSpeed']
def gen():
    yield '<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n <ExportDate value="2026-11-01 10:00:00 +0000"/>\n'
    for i in range(days):
        d=start+datetime.timedelta(days=i)
        # sleep with stages
        bed=-60+random.randint(0,60); m=bed
        while m<420:
            for st,l in (('Core',50),('Deep',25),('REM',25)):
                e=min(420,m+l)
                if m<e: yield rec('HKCategoryTypeIdentifierSleepAnalysis',W,ts(d,m),ts(d,e),'HKCategoryValueSleepAnalysisAsleep'+st)
                m=e
            m+=5
        for t in range(0,1440,5):               # heart rate every 5 min
            hr=52+random.random()*8 if t<420 else 62+random.random()*28
            yield rec('HKQuantityTypeIdentifierHeartRate',W,ts(d,t),ts(d,t),f'{hr:.0f}','count/min')
        for t in range(540,1260,15):             # steps, watch + phone
            v=random.randint(0,900)
            yield rec('HKQuantityTypeIdentifierStepCount',W,ts(d,t),ts(d,t+15),v,'count')
            if random.random()<.5: yield rec('HKQuantityTypeIdentifierStepCount',P,ts(d,t),ts(d,t+15),int(v*.7),'count')
        for t in range(0,1440,2):                # the bulk of a real export: other metrics
            yield rec(random.choice(OTHER),W,ts(d,t),ts(d,t+2),f'{random.random()*10:.3f}','count')
    yield '</HealthData>\n'
xml=os.path.join(out,'export.xml')
with open(xml,'w',encoding='utf-8') as f:
    for chunk in gen(): f.write(chunk)
print('xml MB', os.path.getsize(xml)/1e6)
zp=os.path.join(out,'export.zip')
with zipfile.ZipFile(zp,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    z.write(xml,'apple_health_export/export.xml')
print('zip MB', os.path.getsize(zp)/1e6)
